import { z } from "zod";
import { brandCanUse } from "@/lib/plans/brandAccess";
import type { TenantContext } from "@/lib/tenant/types";
import { isNextUpEnabled } from "./flags";
import { clearLearned, learnedLine, listLearned, removeLearned, type LearnedDeps } from "./learned";

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
