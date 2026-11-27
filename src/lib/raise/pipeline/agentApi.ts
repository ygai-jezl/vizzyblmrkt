import { isCanvasAuthConfigured, tenantContextFromCanvasToken, verifyCanvasContext } from "@/lib/canvas/auth";
import { meaningsOf, numberKeys } from "@/lib/metrics/meanings";
import { listOpenAgentActions } from "@/lib/ontology/agentActions";
import { isRateLimited, type RateLimitConfig, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import { areaLabel, NO_REASON_KEY, RAISE_REASONS } from "@/lib/raise/reasons";
import { readPipeline } from "./board";
import { QUIET_AFTER_DAYS } from "./due";
import { isRaiseFollowupsEnabled, isRaisePipelineEnabled } from "./flags";
import { RAISE_FOLLOWUP_ACTION } from "./followups";
import { AGENT_NOT_SET_UP, AGENT_NOTE, NOUNS, ROLE_WORDS } from "./words";

/**
 * For Vizzy's get_raise_pipeline (/api/agent/raise/pipeline, RAISE_PIPELINE_ENABLED): the brand's
 * investor or funding board, as counts only. People by stage, why the ones in Passed passed, and how
 * many are quiet or past their next step date, each with its meaning. Never a name, an address, a
 * firm or a value: only the team's own stage and reason names, which Vizzy treats as data. Read
 * only. The brand and the member come from the signed canvas token. 6 a minute and 60 an hour per
 * brand.
 */

export type ApiResult = { status: number; body: unknown };

export const AGENT_LIMIT: RateLimitConfig = { prefix: "raise_agent", burstLimit: 6, hourlyLimit: 60 };
/** People read a stage for the counts that need a read (reasons, quiet, past next step). */
export const AGENT_READ_CAP = 500;

export async function raiseAgentGate(req: Request, db?: FirestoreLike): Promise<{ ok: true; ctx: TenantContext } | { ok: false; result: ApiResult }> {
  if (!isRaisePipelineEnabled()) return { ok: false, result: { status: 503, body: { error: "unavailable" } } };
  if (!isCanvasAuthConfigured()) return { ok: false, result: { status: 503, body: { error: "canvas_auth_unconfigured" } } };
  const verified = verifyCanvasContext(req.headers.get("x-canvas-context") ?? "");
  if (!verified.ok) return { ok: false, result: { status: 401, body: { error: "unauthorized", reason: verified.error } } };
  const ctx = tenantContextFromCanvasToken(verified.claims);
  if (await isRateLimited(`tenant:${ctx.tenantId}`, AGENT_LIMIT, { db })) return { ok: false, result: { status: 429, body: { error: "rate_limited" } } };
  return { ok: true, ctx };
}

export interface AgentPipelineDeps {
  db?: FirestoreLike;
  loadTenant?: (id: string) => Promise<Tenant | null>;
  now?: () => Date;
}

const keyRank = new Map(RAISE_REASONS.map((r, i) => [r.key, i]));

/** The board as counts, for Vizzy. */
export async function agentRaisePipeline(ctx: TenantContext, deps: AgentPipelineDeps = {}): Promise<ApiResult> {
  const board = await readPipeline(ctx, { cap: AGENT_READ_CAP }, deps);
  if (!board.setUp) return { status: 200, body: { status: "success", setUp: false, note: AGENT_NOT_SET_UP } };

  const stages = board.columns.map((c) => ({ name: c.label, stage: c.preset, role: ROLE_WORDS[c.role], stagePeople: c.count }));
  const passed = board.columns.filter((c) => c.role === "passed");
  const reasons = new Map<string, { reason: string; name: string; area: string; reasonPasses: number }>();
  const own = new Map<string, { name: string; reasonPasses: number }>();
  let noReasonPasses = 0;
  for (const card of passed.flatMap((c) => c.cards)) {
    const r = card.passReason;
    if (!r || r.key === NO_REASON_KEY) noReasonPasses += 1;
    else if (r.key) {
      const area = board.fields.passReason?.options.find((o) => o.optionId === r.optionId)?.area ?? "other";
      const row = reasons.get(r.key) ?? { reason: r.key, name: r.label, area: areaLabel(area), reasonPasses: 0 };
      row.reasonPasses += 1;
      reasons.set(r.key, row);
    } else {
      const row = own.get(r.optionId) ?? { name: r.label, reasonPasses: 0 };
      row.reasonPasses += 1;
      own.set(r.optionId, row);
    }
  }
  const byCount = <T extends { reasonPasses: number }>(rows: T[], rank: (r: T) => number) => rows.sort((a, b) => b.reasonPasses - a.reasonPasses || rank(a) - rank(b));
  const openFollowUps = isRaiseFollowupsEnabled() ? (await listOpenAgentActions(ctx, { action: RAISE_FOLLOWUP_ACTION, limit: 200, db: deps.db })).length : null;

  const counts = {
    pipelinePeople: board.totals.people,
    stages,
    passes: {
      passedPeople: passed.reduce((n, c) => n + c.count, 0),
      reasons: byCount([...reasons.values()], (r) => keyRank.get(r.reason) ?? 99),
      ownReasons: byCount([...own.values()], () => 0),
      noReasonPasses,
    },
    followUps: {
      quietAfterDays: QUIET_AFTER_DAYS,
      quietPeople: board.totals.quiet,
      nextStepPastPeople: board.totals.nextStepPast,
      overduePeople: board.totals.overdue,
      ...(openFollowUps !== null ? { openFollowUps } : {}),
    },
  };
  return {
    status: 200,
    body: {
      status: "success",
      setUp: true,
      board: NOUNS[board.kind].tab,
      today: board.today,
      ...counts,
      capped: board.totals.capped,
      meanings: meaningsOf(numberKeys(counts)),
      note: AGENT_NOTE,
    },
  };
}
