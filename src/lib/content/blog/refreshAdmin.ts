import { isBlogFreshnessEnabled, isBlogRefreshEnabled } from "@/lib/brandMap/flags";
import { forTenant, getTenantById } from "@/lib/tenant";
import { setTenantRefresh } from "@/lib/tenant/control";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { getContentPlan, updateContentPlanNode } from "@/lib/tenant/workspaceContent";
import type { ContentNode } from "@/lib/types/contentPlan";
import type { Tenant } from "@/lib/types/tenant";
import { articleFreshness, nextEvents } from "./freshness";
import { freshnessWatchId } from "./freshnessPages";
import { clockReadout, readoutLine } from "./refreshReadout";
import { listRecords } from "./refreshRecords";

/**
 * Article freshness's settings and a person's check (BLOG_FRESHNESS_ENABLED): the brand's refresh
 * clock ("test" spreads 20, 30 and 45 days; a number fixes one), how many of Next up's three picks
 * may be refreshes, and "Checked, nothing to change" on one article.
 */

export type ApiResult = { status: number; body: unknown };
export const DEFAULT_REFRESH_SHARE = 1;

export interface RefreshDeps {
  db?: FirestoreLike;
  loadTenant?: (id: string) => Promise<Tenant | null>;
  save?: typeof setTenantRefresh;
  now?: () => Date;
}

/** The brand's settings, and what the freshness watch counted last. */
export async function readRefresh(ctx: TenantContext, deps: RefreshDeps = {}): Promise<ApiResult> {
  if (!isBlogFreshnessEnabled()) return { status: 503, body: { error: "unavailable" } };
  const tenant = await (deps.loadTenant ?? getTenantById)(ctx.tenantId).catch(() => null);
  const watch = await forTenant(ctx, deps.db).freshnessWatch.getById(freshnessWatchId(ctx.tenantId)).catch(() => null);
  // Which clock works (BLOG_REFRESH_ENABLED): the brand's refresh records, summed per clock.
  const readout = isBlogRefreshEnabled() ? clockReadout(await listRecords(ctx, deps).catch(() => [])) : null;
  return {
    status: 200,
    body: {
      clock: tenant?.refreshClock ?? "test",
      share: tenant?.refreshShare ?? DEFAULT_REFRESH_SHARE,
      keepTesting: tenant?.refreshKeepTesting === true,
      counts: watch?.counts ?? null,
      byClock: watch?.byClock ?? null,
      lookedAt: watch?.updatedAt ?? null,
      ...(readout ? { readout: { ...readout, line: readoutLine(readout) } } : {}),
    },
  };
}

/** Admins set them: `{ clock: "test" | 20 | 30 | 45, share: 0..3 }`. */
export async function saveRefresh(ctx: TenantContext, raw: unknown, deps: RefreshDeps = {}): Promise<ApiResult> {
  if (!isBlogFreshnessEnabled()) return { status: 503, body: { error: "unavailable" } };
  if (ctx.role !== "admin") return { status: 403, body: { error: "forbidden" } };
  const body = raw as { clock?: unknown; share?: unknown; keepTesting?: unknown } | null;
  const clock = body?.clock;
  const share = body?.share;
  const keepTesting = body?.keepTesting;
  if (keepTesting !== undefined && typeof keepTesting !== "boolean") return { status: 400, body: { error: "invalid_input" } };
  if (!(clock === "test" || clock === 20 || clock === 30 || clock === 45)) return { status: 400, body: { error: "invalid_clock" } };
  if (typeof share !== "number" || !Number.isInteger(share) || share < 0 || share > 3) return { status: 400, body: { error: "invalid_share" } };
  const ok = await (deps.save ?? setTenantRefresh)(ctx.tenantId, { refreshClock: clock, refreshShare: share, ...(typeof keepTesting === "boolean" ? { refreshKeepTesting: keepTesting } : {}) });
  return ok ? { status: 200, body: { clock, share, ...(typeof keepTesting === "boolean" ? { keepTesting: clock !== "test" && keepTesting } : {}) } } : { status: 404, body: { error: "not_found" } };
}

/**
 * "Checked, nothing to change": the clock starts again from now, Updated stays as it is (Google's
 * rule: a date moves only for a real change), and the check is recorded under its clock. The
 * article leaves the brand's due list until the watch finds a reason again.
 */
export async function markChecked(
  ctx: TenantContext,
  args: { workspaceId: string; planId: string; nodeId: string },
  deps: RefreshDeps = {},
): Promise<{ ok: true; node: ContentNode } | { ok: false; status: number; error: string }> {
  if (!isBlogFreshnessEnabled()) return { ok: false, status: 503, error: "unavailable" };
  const plan = await getContentPlan(ctx, args.workspaceId, args.planId, deps.db);
  const hub = plan?.graph.nodes.find((n) => n.id === args.nodeId);
  if (!plan || !hub || hub.type !== "hub" || hub.channel !== "blog") return { ok: false, status: 404, error: "node_not_found" };
  if (!hub.blog?.live || !hub.blog.freshness || !hub.blog.dates?.published) return { ok: false, status: 409, error: "no_clock" };
  const now = (deps.now ?? (() => new Date()))();
  const at = now.toISOString();
  const node = await updateContentPlanNode(ctx, args.workspaceId, args.planId, args.nodeId, { made: { unstamped: "person_marked_checked" } }, deps.db, {
    setFreshness: (stored, current) => {
      if (!stored) return stored;
      const dates = current.blog?.dates;
      const state = articleFreshness(
        { publishedAt: dates?.published?.at ?? null, updatedAt: dates?.updated?.at ?? null, checkedAt: at, clockDays: stored.clockDays, signals: [] },
        now,
      );
      return {
        ...stored,
        checkedAt: at,
        // The clock starts again, so the next look counts the subject's open questions afresh.
        openAtStart: null,
        ...(state ? { state: state.state, reasons: state.reasons, dueAt: state.dueAt } : {}),
        events: nextEvents(stored.events, { at, kind: "checked", clockDays: stored.clockDays }),
      };
    },
  });
  if (!node) return { ok: false, status: 404, error: "node_not_found" };
  await leaveDueList(ctx, args.planId, at, deps);
  return { ok: true, node };
}

/** Off the brand's due list at once (checked or refreshed), so Review and Next up stop offering it. */
export async function leaveDueList(ctx: TenantContext, planId: string, at: string, deps: { db?: FirestoreLike } = {}): Promise<void> {
  await forTenant(ctx, deps.db)
    .freshnessWatch.claim(freshnessWatchId(ctx.tenantId), (w) => {
      const gone = w.due.find((d) => d.planId === planId);
      if (!gone) return null;
      return {
        due: w.due.filter((d) => d.planId !== planId),
        counts: { ...w.counts, [gone.state]: Math.max(0, w.counts[gone.state] - 1), fresh: w.counts.fresh + 1 },
        updatedAt: at,
      };
    })
    .catch(() => null);
}
