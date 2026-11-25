import { searchConsoleManifest } from "@/lib/connectors/manifests/searchConsole";
import { planningConnections } from "@/lib/connectors/signals/review";
import { readDayDocs } from "@/lib/connectors/snapshots";
import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { PageWindow, RefreshRecord } from "@/lib/types/articleRefresh";
import type { DataConnection } from "@/lib/types/dataConnection";
import type { MetricSnapshot } from "@/lib/types/metricSnapshot";
import { accountCovers, articlePageKey, freshnessWatchId, signalPageKey } from "./freshnessPages";
import { listRecords, recordId } from "./refreshRecords";

/**
 * What came of a refresh (BLOG_REFRESH_ENABLED): Search Console's clicks, impressions and position
 * for the article's page over the 28 days before the change was applied and the 28 days after,
 * beside the brand's other live articles that weren't refreshed in those 56 days (the control, so
 * a seasonal dip isn't blamed on a clock). Read from the daily page rows Search Console's
 * connection keeps for 90 days, once the 28 days after are final. Google's numbers stay inside the
 * brand: this writes them on the brand's own record only.
 */

export const OUTCOME = {
  WINDOW_DAYS: 28,
  /** Search Console's days are final about 3 days late. */
  LAG_DAYS: 3,
  /** Daily page rows are kept this long; a window older than this can't be read. */
  KEPT_DAYS: 90,
  PER_BRAND_PER_DAY: 10,
} as const;

const SEARCH_STREAM = searchConsoleManifest.produces[0]!.stream;
const DAY_MS = 86_400_000;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface OutcomeDeps {
  db?: FirestoreLike;
  now?: () => Date;
  connections?: (ctx: TenantContext) => Promise<DataConnection[]>;
  /** Day docs for a connection's page grouping (tests). */
  dayDocs?: (ctx: TenantContext, conn: DataConnection, from: string, to: string, each: (doc: MetricSnapshot) => void) => Promise<void>;
}

interface Sums {
  clicks: number;
  impressions: number;
  positionWeight: number;
}
const empty = (): Sums => ({ clicks: 0, impressions: 0, positionWeight: 0 });
const windowOf = (s: Sums): PageWindow => ({ clicks: s.clicks, impressions: s.impressions, position: s.impressions ? Math.round((s.positionWeight / s.impressions) * 10) / 10 : null });

/** Clicks after against before, beside the control's change. Null when either has nothing to compare. */
export function liftOf(before: number, after: number, controlBefore: number, controlAfter: number): number | null {
  if (before <= 0 || controlBefore <= 0 || controlAfter <= 0) return null;
  return Math.round(((after / before) / (controlAfter / controlBefore) - 1) * 1000) / 1000;
}

const noSearchConsole = (at: string): RefreshRecord["outcome"] => ({ searchConsole: false, before: null, after: null, control: null, lift: null, measuredAt: at });

/** Measure the brand's refreshes whose 28 days after are now final. Returns how many it measured. */
export async function measureOutcomes(ctx: TenantContext, deps: OutcomeDeps = {}): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const at = now.toISOString();
  const ready = now.getTime() - (OUTCOME.WINDOW_DAYS + OUTCOME.LAG_DAYS) * DAY_MS;
  const records = await listRecords(ctx, deps).catch(() => [] as RefreshRecord[]);
  const due = records
    .filter((r) => r.decision?.outcome === "applied" && r.decision.real && !r.outcome && Date.parse(r.decision.at) <= ready)
    .slice(0, OUTCOME.PER_BRAND_PER_DAY);
  if (!due.length) return 0;
  const conns = deps.connections ? await deps.connections(ctx) : [...(await planningConnections(ctx, { db: deps.db }).catch(() => new Map<string, DataConnection>())).values()];
  const watch = await forTenant(ctx, deps.db).freshnessWatch.getById(freshnessWatchId(ctx.tenantId)).catch(() => null);
  const repo = forTenant(ctx, deps.db).refreshRecords;
  let measured = 0;
  for (const r of due) {
    const outcome = await measureOne(ctx, r, records, conns, watch?.pages ?? [], now, deps).catch(() => null);
    if (!outcome) continue;
    const done = await repo.claim(recordId(r.reviewId), (cur) => (cur.outcome ? null : { outcome: { ...outcome, measuredAt: at } })).catch(() => null);
    if (done) measured += 1;
  }
  return measured;
}

async function measureOne(
  ctx: TenantContext,
  r: RefreshRecord,
  all: RefreshRecord[],
  conns: DataConnection[],
  pages: Array<{ key: string; planId: string }>,
  now: Date,
  deps: OutcomeDeps,
): Promise<NonNullable<RefreshRecord["outcome"]>> {
  const at = now.toISOString();
  const liveUrl = r.observation.liveUrl;
  if (!liveUrl) return noSearchConsole(at)!;
  let url: URL;
  try {
    url = new URL(liveUrl);
  } catch {
    return noSearchConsole(at)!;
  }
  const key = articlePageKey(liveUrl);
  const conn = conns.find((c) => c.account && accountCovers(c.account, url.hostname));
  const gen = conn?.collect?.gen;
  if (!conn || (gen === undefined || gen === null)) return noSearchConsole(at)!;

  const decided = Date.parse(r.decision!.at);
  const split = dayOf(decided);
  const from = dayOf(decided - OUTCOME.WINDOW_DAYS * DAY_MS);
  const to = dayOf(decided + OUTCOME.WINDOW_DAYS * DAY_MS);
  // The before window has to still be kept.
  if (from < dayOf(now.getTime() - OUTCOME.KEPT_DAYS * DAY_MS)) return noSearchConsole(at)!;

  // The control: the brand's other live articles not refreshed in these 56 days.
  const refreshed = new Set(
    all
      .filter((x) => x.decision?.outcome === "applied" && x.decision.real && x.observation.liveUrl && dayOf(Date.parse(x.decision.at)) >= from && dayOf(Date.parse(x.decision.at)) <= to)
      .map((x) => articlePageKey(x.observation.liveUrl!)),
  );
  refreshed.add(key);
  const control = new Set(pages.map((p) => p.key).filter((k) => !refreshed.has(k)));

  const before = empty();
  const after = empty();
  const ctrl = { before: 0, after: 0, seen: new Set<string>() };
  const each = (doc: MetricSnapshot) => {
    if (!doc.day || doc.day === split) return;
    const late = doc.day > split;
    for (const row of doc.rows) {
      const k = signalPageKey(row.host, conn.account, row.key);
      const clicks = Number(row.m.searchClicks ?? 0);
      if (k === key) {
        const s = late ? after : before;
        const imp = Number(row.m.searchImpressions ?? 0);
        s.clicks += clicks;
        s.impressions += imp;
        if (typeof row.m.searchPosition === "number") s.positionWeight += row.m.searchPosition * imp;
      } else if (control.has(k)) {
        if (late) ctrl.after += clicks;
        else ctrl.before += clicks;
        ctrl.seen.add(k);
      }
    }
  };
  if (deps.dayDocs) await deps.dayDocs(ctx, conn, from, to, each);
  else await readDayDocs(ctx, { id: conn.id, gen }, SEARCH_STREAM, "page", from, to, { db: deps.db, each });

  return {
    searchConsole: true,
    before: windowOf(before),
    after: windowOf(after),
    control: { before: ctrl.before, after: ctrl.after, pages: ctrl.seen.size },
    lift: liftOf(before.clicks, after.clicks, ctrl.before, ctrl.after),
    measuredAt: at,
  };
}
