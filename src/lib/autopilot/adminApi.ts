import { z } from "zod";
import { brandCanUse } from "@/lib/plans/brandAccess";
import type { TenantContext } from "@/lib/tenant/types";
import { isNextUpEnabled } from "./flags";
import { addLearned, clearLearned, learnedLine, listLearned, removeLearned, type LearnedDeps } from "./learned";
import { isRateLimited } from "@/lib/tenant/rateLimit";
import { dropPick, pickNextUp, readNextUp, type PickDeps } from "@/lib/nextUp/pick";

/**
 * Admin APIs for the next article autopilot on Brand › Brand map. Routes call these after the
 * origin check and sign-in; the brand always comes from the session.
 */

export type ApiResult = { status: number; body: unknown };

export interface AutopilotAdminDeps extends LearnedDeps {
  canUse?: (ctx: TenantContext) => Promise<boolean>;
}

/** The switch and the brand's next_up feature, or why not. */
export async function nextUpGate(ctx: TenantContext, deps: AutopilotAdminDeps = {}): Promise<ApiResult | null> {
  if (!isNextUpEnabled()) return { status: 503, body: { error: "unavailable" } };
  const ok = await (deps.canUse ?? ((c) => brandCanUse(c, "next_up")))(ctx).catch(() => false);
  return ok ? null : { status: 403, body: { error: "not_included" } };
}

/** The Learned list, newest first, each with the line picking and the judge read. */
export async function readLearned(ctx: TenantContext, deps: AutopilotAdminDeps = {}): Promise<ApiResult> {
  const blocked = await nextUpGate(ctx, deps);
  if (blocked) return blocked;
  const list = await listLearned(ctx, deps);
  return { status: 200, body: { learned: list.map((e) => ({ id: e.id, kind: e.kind, text: e.text, reason: e.reason, from: e.from, at: e.at, line: learnedLine(e) })) } };
}

const Forget = z.union([z.object({ id: z.string().regex(/^lrn_[a-f0-9]{20}$/) }), z.object({ all: z.literal(true) })]);

/** Admins take one entry off the list, or clear it. */
export async function forgetLearned(ctx: TenantContext, raw: unknown, deps: AutopilotAdminDeps = {}): Promise<ApiResult> {
  const blocked = await nextUpGate(ctx, deps);
  if (blocked) return blocked;
  if (ctx.role !== "admin") return { status: 403, body: { error: "forbidden" } };
  const parsed = Forget.safeParse(raw);
  if (!parsed.success) return { status: 400, body: { error: "invalid_input" } };
  if ("all" in parsed.data) return { status: 200, body: { removed: await clearLearned(ctx, deps) } };
  return (await removeLearned(ctx, parsed.data.id, deps)) ? { status: 200, body: { removed: 1 } } : { status: 404, body: { error: "not_found" } };
}

// ---- Next up ---------------------------------------------------------------------------------------

const REFRESH_LIMIT = { prefix: "next_up_refresh", burstLimit: 2, hourlyLimit: 6 };
/** A refresh may take this long (the route has 60 s). */
const REFRESH_MS = 50_000;

export interface NextUpAdminDeps extends AutopilotAdminDeps, Pick<PickDeps, "generate" | "configured" | "search" | "candidates" | "flags" | "notOnMap" | "competitorNames" | "activeQuestionIds"> {
  rateLimited?: (subject: string) => Promise<boolean>;
}

/** The brand's stored Next up (null until the first pick). */
export async function readNextUpApi(ctx: TenantContext, deps: NextUpAdminDeps = {}): Promise<ApiResult> {
  const blocked = await nextUpGate(ctx, deps);
  if (blocked) return blocked;
  return { status: 200, body: { nextUp: await readNextUp(ctx, deps) } };
}

/** Choose again now (members may: picking costs one model call, and it is rate limited). */
export async function refreshNextUp(ctx: TenantContext, deps: NextUpAdminDeps = {}): Promise<ApiResult> {
  const blocked = await nextUpGate(ctx, deps);
  if (blocked) return blocked;
  const limited = deps.rateLimited ?? ((s: string) => isRateLimited(s, REFRESH_LIMIT));
  if (await limited(`tenant:${ctx.tenantId}`)) return { status: 429, body: { error: "rate_limited" } };
  const got = await pickNextUp(ctx, { by: "person", deadlineMs: Date.now() + REFRESH_MS }, deps);
  if (!got.ok) return { status: got.error === "out_of_time" ? 503 : 409, body: { error: got.error } };
  return { status: 200, body: { nextUp: got.doc } };
}

const Skip = z.object({
  questionId: z
    .string()
    .trim()
    .regex(/^q_[A-Za-z0-9]{6,40}$/),
  question: z.string().trim().min(1).max(300),
  reason: z.string().trim().max(200).optional(),
});

/** Not now: off the list, and kept on the Learned list with the reason given. */
export async function skipPick(ctx: TenantContext, raw: unknown, deps: NextUpAdminDeps = {}): Promise<ApiResult> {
  const blocked = await nextUpGate(ctx, deps);
  if (blocked) return blocked;
  const parsed = Skip.safeParse(raw);
  if (!parsed.success) return { status: 400, body: { error: "invalid_input" } };
  await addLearned(ctx, { kind: "skipped_pick", text: parsed.data.question, reason: parsed.data.reason ?? "", questionId: parsed.data.questionId, from: "person" }, deps);
  const doc = await dropPick(ctx, parsed.data.questionId, deps);
  return { status: 200, body: { nextUp: doc ?? (await readNextUp(ctx, deps)) } };
}
