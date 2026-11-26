import { z } from "zod";
import { brandCanUse } from "@/lib/plans/brandAccess";
import type { TenantContext } from "@/lib/tenant/types";
import { isAutopilotEnabled, isNextUpEnabled, isNextUpRepeatsEnabled } from "./flags";
import { isBlogRefreshEnabled } from "@/lib/brandMap/flags";
import { mayStartReview } from "@/lib/content/blog/refreshGate";
import { startReview } from "@/lib/content/blog/refreshReview";
import { refreshHref } from "@/lib/content/blog/freshnessHref";
import { getContentPlan } from "@/lib/tenant/workspaceContent";
import { AUTOPILOT_RUNNING, autopilotHolds } from "./planLock";
import { nextUpDocId, type NextUpPick } from "@/lib/types/autopilot";
import { addLearned, clearLearned, learnedLine, listLearned, removeLearned, type LearnedDeps } from "./learned";
import { isRateLimited } from "@/lib/tenant/rateLimit";
import { dropPick, pickNextUp, readNextUp, type PickDeps } from "@/lib/nextUp/pick";
import type { AutopilotRun } from "@/lib/types/autopilot";
import { advanceRun, type AdvanceDeps } from "./advance";
import { createRun, draftsThisMonth, freshRunId, getRun, heldQuestionIds, readyToWrite, recentRuns, updateTrays } from "./runs";
import { forTenant, getTenantById } from "@/lib/tenant";
import { setTenantAutopilot } from "@/lib/tenant/control";
import { tenantMayUse } from "@/lib/plans/brandAccess";
import { monthlyLimit } from "@/lib/plans/limits";
import { lookupsThisMonth } from "@/lib/signals/store";
import { AutopilotSettingsSchema } from "@/lib/types/autopilot";
import type { Tenant } from "@/lib/types/tenant";
import { fileSuggestions } from "@/lib/brandMap/filing";

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
  // Questions scheduled runs sorted and left ready to write (last 7 days), newest first. `ready` is the newest.
  const readyAll = isAutopilotEnabled() ? readyToWrite(await recentRuns(ctx, 100, deps).catch(() => []), Date.now()).map(runView) : [];
  return { status: 200, body: { nextUp: await readNextUp(ctx, deps), ready: readyAll[0] ?? null, readyAll } };
}

/** Choose again now (members may: picking costs one model call, and it is rate limited). */
export async function refreshNextUp(ctx: TenantContext, deps: NextUpAdminDeps = {}): Promise<ApiResult> {
  const blocked = await nextUpGate(ctx, deps);
  if (blocked) return blocked;
  const limited = deps.rateLimited ?? ((s: string) => isRateLimited(s, REFRESH_LIMIT));
  if (await limited(`tenant:${ctx.tenantId}`)) return { status: 429, body: { error: "rate_limited" } };
  const got = await pickNextUp(ctx, { by: "person", deadlineMs: Date.now() + REFRESH_MS }, { activeQuestionIds: (c) => heldQuestionIds(c, deps), ...deps });
  if (!got.ok) return { status: got.error === "out_of_time" ? 503 : 409, body: { error: got.error } };
  return { status: 200, body: { nextUp: got.doc } };
}

const Skip = z.object({
  /** A question's id, or "refresh:<planId>" for a live article due a refresh. */
  questionId: z
    .string()
    .trim()
    .regex(/^(q_[A-Za-z0-9]{6,40}|refresh:[A-Za-z0-9_-]{6,80}|combine:q_[A-Za-z0-9]{6,40})$/),
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

const Close = z.object({
  questionId: z
    .string()
    .trim()
    .regex(/^q_[A-Za-z0-9]{6,40}$/),
  action: z.enum(["add", "write_anyway"]),
});

const withoutClose = ({ closeTo: _drop, ...rest }: NextUpPick): NextUpPick => rest;

export interface ClosePickDeps extends NextUpAdminDeps {
  loadTenant?: (id: string) => Promise<Tenant | null>;
  review?: typeof startReview;
}

/**
 * A pick close to a live article (NEXT_UP_REPEATS_ENABLED). `add`: a refresh review of that article
 * starts, carrying the question, and the pick is done; the person goes to the article. `write_anyway`:
 * the pick stays, without its close mark, and the question isn't marked close again for 90 days.
 * Both are kept on the Learned list. Members may, as for Not now.
 */
export async function closePick(ctx: TenantContext, raw: unknown, deps: ClosePickDeps = {}): Promise<ApiResult> {
  const blocked = await nextUpGate(ctx, deps);
  if (blocked) return blocked;
  if (!isNextUpRepeatsEnabled()) return { status: 503, body: { error: "unavailable" } };
  const parsed = Close.safeParse(raw);
  if (!parsed.success) return { status: 400, body: { error: "invalid_input" } };
  const { questionId, action } = parsed.data;
  const doc = await readNextUp(ctx, deps);
  const pick = doc?.picks.find((p) => p.questionId === questionId && p.closeTo);
  if (!pick?.closeTo) return { status: 404, body: { error: "not_found" } };

  if (action === "write_anyway") {
    await addLearned(ctx, { kind: "wrote_anyway", text: pick.question, questionId, from: "person" }, deps);
    const next = await forTenant(ctx, deps.db).nextUp.claim(nextUpDocId(ctx.tenantId), (cur) =>
      cur.picks.some((p) => p.questionId === questionId && p.closeTo) ? { picks: cur.picks.map((p) => (p.questionId === questionId ? withoutClose(p) : p)) } : null,
    );
    return { status: 200, body: { nextUp: next ?? (await readNextUp(ctx, deps)) } };
  }

  const to = pick.closeTo;
  if (!to.planId || !to.workspaceId) return { status: 409, body: { error: "not_written_here" } };
  if (!isBlogRefreshEnabled()) return { status: 503, body: { error: "refresh_unavailable" } };
  const may = await mayStartReview(ctx, { db: deps.db, ...(deps.loadTenant ? { loadTenant: deps.loadTenant } : {}) });
  if (!may.ok) return { status: may.status, body: { error: may.error } };
  const plan = await getContentPlan(ctx, to.workspaceId, to.planId, deps.db);
  if (!plan) return { status: 404, body: { error: "article_gone" } };
  if (autopilotHolds(plan)) return { status: 409, body: AUTOPILOT_RUNNING };
  const started = await (deps.review ?? startReview)(ctx, { plan, by: "person", question: { id: questionId, text: pick.question } }, { db: deps.db });
  if (!started.ok) return { status: started.status, body: { error: started.error } };
  await addLearned(ctx, { kind: "added_to_article", text: pick.question, reason: to.title, questionId, from: "person" }, deps);
  const next = await dropPick(ctx, questionId, deps);
  return { status: 200, body: { link: refreshHref({ planId: plan.id, workspaceId: plan.workspaceId }), started: started.started, nextUp: next ?? (await readNextUp(ctx, deps)) } };
}

// ---- Find and sort ---------------------------------------------------------------------------------

const FindInput = z.object({
  questionId: z.string().trim().regex(/^q_[A-Za-z0-9]{6,40}$/),
  question: z.string().trim().min(3).max(300),
  subjectId: z.string().trim().regex(/^sub_[A-Za-z0-9]{6,40}$/),
  subjectName: z.string().trim().min(1).max(120),
});

const FIND_LIMIT = { prefix: "autopilot_find", burstLimit: 3, hourlyLimit: 20 };
/** A page waits this long for a step before answering. */
const PAGE_STEP_MS = 45_000;

/** What a page sees of a run. */
export function runView(run: AutopilotRun) {
  return {
    id: run.id,
    mode: run.mode,
    step: run.step,
    question: run.question,
    trays: run.trays,
    googleSkipped: run.googleSkipped,
    planId: run.planId,
    workspaceId: run.workspaceId,
    error: run.step === "failed" ? run.error : null,
    createdAt: run.createdAt,
  };
}

/** Find what buyers ask for one of Next up's questions, and sort it (a run, mode "find"). */
export async function startFind(ctx: TenantContext, raw: unknown, deps: NextUpAdminDeps & AdvanceDeps = {}): Promise<ApiResult> {
  const blocked = await nextUpGate(ctx, deps);
  if (blocked) return blocked;
  const parsed = FindInput.safeParse(raw);
  if (!parsed.success) return { status: 400, body: { error: "invalid_input" } };
  const limited = deps.rateLimited ?? ((s: string) => isRateLimited(s, FIND_LIMIT));
  if (await limited(`tenant:${ctx.tenantId}`)) return { status: 429, body: { error: "rate_limited" } };
  const { questionId, question, subjectId, subjectName } = parsed.data;
  const run = await createRun(ctx, { id: freshRunId(), mode: "find", trigger: "person", step: "find", question: { questionId, text: question, subjectId, subjectName } }, deps);
  const after = (await advanceRun(ctx, run.id, { deadlineMs: Date.now() + PAGE_STEP_MS }, deps)) ?? run;
  return { status: 200, body: { run: runView(after) } };
}

const RUN_ID = /^run_[a-f0-9]{24}$/;

/** A run, advanced one step first when it's due (so a person waiting needn't wait for the tick). */
export async function readRunApi(ctx: TenantContext, id: string, deps: NextUpAdminDeps & AdvanceDeps = {}): Promise<ApiResult> {
  const blocked = await nextUpGate(ctx, deps);
  if (blocked) return blocked;
  if (!RUN_ID.test(id)) return { status: 400, body: { error: "invalid_input" } };
  const run = await getRun(ctx, id, deps);
  if (!run) return { status: 404, body: { error: "not_found" } };
  const after = run.active && run.mode === "find" ? ((await advanceRun(ctx, id, { deadlineMs: Date.now() + PAGE_STEP_MS }, deps)) ?? run) : run;
  return { status: 200, body: { run: runView(after) } };
}

const Move = z.object({ text: z.string().trim().min(1).max(300), to: z.enum(["use", "other", "drop"]) });
const TRAY_WORD = { use: "this article", other: "another article", drop: "not for us" } as const;

/** Move an item between trays. Kept on the Learned list, so the judge learns from it. */
export async function moveItem(ctx: TenantContext, id: string, raw: unknown, deps: NextUpAdminDeps = {}): Promise<ApiResult> {
  const blocked = await nextUpGate(ctx, deps);
  if (blocked) return blocked;
  if (!RUN_ID.test(id)) return { status: 400, body: { error: "invalid_input" } };
  const parsed = Move.safeParse(raw);
  if (!parsed.success) return { status: 400, body: { error: "invalid_input" } };
  const run = await getRun(ctx, id, deps);
  if (!run?.trays) return { status: 404, body: { error: "not_found" } };
  const trays = { use: [...run.trays.use], other: [...run.trays.other], drop: [...run.trays.drop] };
  const from = (Object.keys(trays) as Array<keyof typeof trays>).find((k) => trays[k].some((i) => i.text === parsed.data.text));
  if (!from) return { status: 404, body: { error: "not_found" } };
  if (from === parsed.data.to) return { status: 200, body: { run: runView(run) } };
  const item = trays[from].find((i) => i.text === parsed.data.text)!;
  trays[from] = trays[from].filter((i) => i !== item);
  trays[parsed.data.to].push({ ...item, reason: "moved by your team" });
  const saved = await updateTrays(ctx, id, trays, deps);
  await addLearned(
    ctx,
    {
      kind: from === "drop" && parsed.data.to === "use" ? "added_back" : "moved",
      text: item.text,
      reason: `from ${TRAY_WORD[from]} to ${TRAY_WORD[parsed.data.to]}${run.question ? `, for "${run.question.text}"` : ""}`,
      questionId: run.question?.questionId ?? null,
      from: "person",
    },
    deps,
  );
  return { status: 200, body: { run: runView(saved ?? run) } };
}

const Suggest = z.object({ texts: z.array(z.string().trim().min(1).max(300)).min(1).max(10) });

/** Admins file "Another subject" items as suggestions for the brand map (from Next up). */
export async function suggestOthers(ctx: TenantContext, id: string, raw: unknown, deps: NextUpAdminDeps = {}): Promise<ApiResult> {
  const blocked = await nextUpGate(ctx, deps);
  if (blocked) return blocked;
  if (ctx.role !== "admin") return { status: 403, body: { error: "forbidden" } };
  if (!RUN_ID.test(id)) return { status: 400, body: { error: "invalid_input" } };
  const parsed = Suggest.safeParse(raw);
  if (!parsed.success) return { status: 400, body: { error: "invalid_input" } };
  const run = await getRun(ctx, id, deps);
  if (!run?.trays) return { status: 404, body: { error: "not_found" } };
  // Only items this run put on "Another subject", so a page can't file anything else.
  const items = run.trays.other.filter((i) => parsed.data.texts.includes(i.text) && i.subject);
  if (!items.length) return { status: 400, body: { error: "invalid_input" } };
  const filed = await fileSuggestions(
    ctx,
    {
      from: "autopilot",
      items: items.map((i) => ({
        change: { type: "add_question", subject: i.subject!.replace(/^new:\s*/i, "").slice(0, 80), text: i.text.slice(0, 300), intent: "other" },
        reason: `Found while sorting "${run.question?.text ?? "a question"}": ${i.reason}`.slice(0, 300),
      })),
    },
    { db: deps.db },
  );
  if (!filed.ok) return { status: 409, body: { error: "map_unavailable" } };
  return { status: 200, body: { filed: filed.value.filed.length, skipped: filed.value.skipped } };
}

// ---- Settings --------------------------------------------------------------------------------------

export interface SettingsDeps extends NextUpAdminDeps {
  loadTenant?: (id: string) => Promise<Tenant | null>;
  save?: typeof setTenantAutopilot;
  listProgrammes?: (ctx: TenantContext) => Promise<Array<{ id: string; name: string }>>;
  drafts?: (ctx: TenantContext) => Promise<number>;
  lookups?: (ctx: TenantContext) => Promise<number>;
}

const programmesOf = async (ctx: TenantContext, deps: SettingsDeps) =>
  deps.listProgrammes
    ? deps.listProgrammes(ctx)
    : (await forTenant(ctx, deps.db).workspaces.find({ limit: 200 })).filter((w) => !w.archivedAt).map((w) => ({ id: w.id, name: w.name }));

/** The brand's autopilot settings, what it may do, and this month's use. */
export async function readAutopilotSettings(ctx: TenantContext, deps: SettingsDeps = {}): Promise<ApiResult> {
  if (!isAutopilotEnabled()) return { status: 503, body: { error: "unavailable" } };
  const blocked = await nextUpGate(ctx, deps);
  if (blocked) return blocked;
  const tenant = await (deps.loadTenant ?? getTenantById)(ctx.tenantId).catch(() => null);
  const settings = AutopilotSettingsSchema.parse(tenant?.autopilot ?? {});
  const [programmes, drafts, lookups] = await Promise.all([
    programmesOf(ctx, deps).catch(() => []),
    (deps.drafts ?? ((c) => draftsThisMonth(c, deps)))(ctx).catch(() => 0),
    (deps.lookups ?? ((c) => lookupsThisMonth(c, deps)))(ctx).catch(() => 0),
  ]);
  return {
    status: 200,
    body: {
      settings,
      canDraft: tenantMayUse(tenant, "article_autopilot"),
      programmes,
      month: { lookups, lookupLimit: monthlyLimit(tenant, "next_up"), drafts, draftLimit: monthlyLimit(tenant, "article_autopilot") },
    },
  };
}

/** Admins change the settings. Draft needs the brand's article_autopilot feature, and a programme. */
export async function saveAutopilotSettings(ctx: TenantContext, raw: unknown, deps: SettingsDeps = {}): Promise<ApiResult> {
  if (!isAutopilotEnabled()) return { status: 503, body: { error: "unavailable" } };
  const blocked = await nextUpGate(ctx, deps);
  if (blocked) return blocked;
  if (ctx.role !== "admin") return { status: 403, body: { error: "forbidden" } };
  const parsed = AutopilotSettingsSchema.safeParse(raw);
  if (!parsed.success) return { status: 400, body: { error: "invalid_input" } };
  const settings = parsed.data;
  const tenant = await (deps.loadTenant ?? getTenantById)(ctx.tenantId).catch(() => null);
  if (settings.mode === "draft" && !tenantMayUse(tenant, "article_autopilot")) return { status: 403, body: { error: "not_included" } };
  const programmes = await programmesOf(ctx, deps).catch(() => []);
  if (settings.workspaceId && !programmes.some((p) => p.id === settings.workspaceId)) return { status: 400, body: { error: "invalid_input" } };
  if (settings.mode === "draft" && !settings.workspaceId && programmes.length !== 1) return { status: 400, body: { error: "programme_required" } };
  const ok = await (deps.save ?? setTenantAutopilot)(ctx.tenantId, settings);
  return ok ? { status: 200, body: { settings } } : { status: 404, body: { error: "not_found" } };
}
