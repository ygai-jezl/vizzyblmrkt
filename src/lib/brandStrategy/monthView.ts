import { NextResponse } from "next/server";
import { z } from "zod";
import { listSituations } from "@/lib/brandMap/situations";
import { liveCoverage, type OutcomeDeps } from "@/lib/connectors/outcomes";
import type { KindCoverage } from "@/lib/metrics/outcomes";
import { getTenantById } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { BrandMapSituation } from "@/lib/types/brandMapRecords";
import { MONTH_REST_ID, type MonthRow, type StrategyMonth } from "@/lib/types/brandStrategy";
import type { Tenant } from "@/lib/types/tenant";
import { lookAtMonth, previewMonth, type MonthDeps } from "./month";
import { GONE_TEXT, REST_TEXT, firstApprovedAt, firstMonth, lookDayOf, monthCounts, monthDue, tooEarly, type MonthRecord } from "./monthRules";
import { readBrandStrategyDoc } from "./store";

/**
 * How it went on the Strategy tab (STRATEGY_RESULTS_ENABLED): the months kept on the strategy
 * record, each row with its situation's words read from the brand map now, and what each kind of
 * result can be measured from now (live coverage, no numbers read). Any member reads it; an admin can
 * add up last month by hand when it is due, or preview this month so far without keeping it (the
 * dev check), each reading the brand's own connections now.
 */

export { GONE_TEXT, REST_TEXT };

export type ShownMonth = Omit<StrategyMonth, "rows"> & { rows: Array<MonthRow & { text: string }> };

export interface StrategyMonthsView {
  approvedAt: string | null;
  /** When the strategy was first approved: How it went starts with the first full month after it. */
  firstApprovedAt: string | null;
  /** No month kept yet, and the first full month after the first approval isn't added up yet. */
  tooEarly: boolean;
  /** The day the next month is added up (YYYY-MM-DD): today when one is due, else a 2nd of the month. */
  nextLookOn: string;
  months: ShownMonth[];
  measuring: KindCoverage[];
}

export interface MonthViewDeps {
  db?: FirestoreLike;
  now?: () => Date;
  catalog?: OutcomeDeps["catalog"];
}

const noStore = { "cache-control": "no-store" };

/** The months as shown: each row with its words. Pure. */
export function shownMonths(months: readonly StrategyMonth[], situations: ReadonlyArray<Pick<BrandMapSituation, "id" | "text">>): ShownMonth[] {
  const words = new Map(situations.map((s) => [s.id, s.text] as const));
  return months.map((m) => ({ ...m, rows: m.rows.map((r) => ({ ...r, text: r.id === MONTH_REST_ID ? REST_TEXT : (words.get(r.id) ?? GONE_TEXT) })) }));
}

/**
 * When the next month is added up: today when one is due now; before the first month's look day,
 * that day; else the 2nd of next month (or of this one, on the 1st).
 */
function nextLookOn(doc: MonthRecord | null, nowMs: number): string {
  const d = new Date(nowMs);
  const today = d.toISOString().slice(0, 10);
  if (doc && monthDue(doc, nowMs)) return today;
  const first = doc ? firstApprovedAt(doc) : null;
  const firstDay = first ? lookDayOf(firstMonth(first)) : null;
  if (firstDay && firstDay > today) return firstDay;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + (d.getUTCDate() < 2 ? 0 : 1), 2)).toISOString().slice(0, 10);
}

export async function strategyMonthsView(ctx: TenantContext, deps: MonthViewDeps = {}): Promise<StrategyMonthsView> {
  const now = (deps.now ?? (() => new Date()))().getTime();
  const [doc, situations, measuring] = await Promise.all([
    readBrandStrategyDoc(ctx, { db: deps.db }),
    listSituations(ctx, { db: deps.db }).catch(() => [] as BrandMapSituation[]),
    liveCoverage(ctx, { db: deps.db, catalog: deps.catalog }),
  ]);
  const approvedAt = doc?.approved?.at ?? null;
  // Only months from the first full month after the first approval: never a partial first month.
  const months = doc && doc.approved ? doc.months.filter((m) => monthCounts(doc, m.month)) : [];
  const record = doc && doc.approved ? { ...doc, months } : null;
  return {
    approvedAt,
    firstApprovedAt: record ? firstApprovedAt(record) : null,
    tooEarly: record ? tooEarly(record, now) : true,
    nextLookOn: nextLookOn(record, now),
    months: shownMonths(months, situations),
    measuring,
  };
}

/** GET map/strategy/month: any member reads it. */
export async function monthsFromRequest(ctx: TenantContext, deps: MonthViewDeps = {}): Promise<Response> {
  return NextResponse.json({ howItWent: await strategyMonthsView(ctx, deps) }, { headers: noStore });
}

/** What POST map/strategy/month takes: nothing, or {"preview": true} for this month so far. */
export const RunMonthSchema = z.object({ preview: z.boolean().optional() }).strict();

/** The words a preview answers with: it is never kept, and a month before the first full one never will be. */
export const PREVIEW_NOTE = (lookOn: string, counts = true) =>
  counts
    ? `A preview of this month so far. It isn't kept: this month is added up on ${lookOn}, once.`
    : `A preview of this month so far. It isn't kept, and this month won't be: How it went starts with the first full month after your first approval, added up on ${lookOn}.`;

type RunDeps = MonthDeps & MonthViewDeps & { loadTenant?: (id: string) => Promise<Tenant | null> };

/**
 * POST map/strategy/month (admins), for the caller's own brand only:
 *  - nothing sent: add up last month now, only when it is due and not kept (the tick's rules), so a
 *    kept month is never written again. 409 `no_month` without an approved strategy, `no_month_due`
 *    when no month is due, `month_held` when a connected tool couldn't be read (tried again tomorrow);
 *  - {"preview": true}: this month so far, from the 1st to now, with connected results over the last
 *    28 days as of today, answered and never written.
 */
export async function runMonthFromRequest(ctx: TenantContext, body: unknown, deps: RunDeps = {}): Promise<Response> {
  const parsed = RunMonthSchema.safeParse(body ?? {});
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const now = (deps.now ?? (() => new Date()))().getTime();
  const tenant = await (deps.loadTenant ?? getTenantById)(ctx.tenantId).catch(() => null);
  const doc = await readBrandStrategyDoc(ctx, { db: deps.db });
  if (!doc?.approved) return NextResponse.json({ error: "no_month" }, { status: 409 });
  if (parsed.data.preview) {
    const month = await previewMonth(ctx, tenant, deps);
    if (!month) return NextResponse.json({ error: "no_month" }, { status: 409 });
    const situations = await listSituations(ctx, { db: deps.db }).catch(() => [] as BrandMapSituation[]);
    const counts = monthCounts(doc, month.month);
    const lookOn = counts ? lookDayOf(month.month) : lookDayOf(firstMonth(firstApprovedAt(doc)!));
    return NextResponse.json({ preview: { month: shownMonths([month], situations)[0], kept: false, note: PREVIEW_NOTE(lookOn, counts) } }, { headers: noStore });
  }
  const due = monthDue(doc, now);
  if (!due) return NextResponse.json({ error: "no_month_due", nextLookOn: nextLookOn(doc, now) }, { status: 409 });
  const done = await lookAtMonth(ctx, tenant, deps, { month: due });
  if (done && "held" in done) return NextResponse.json({ error: "month_held", retryAt: done.held.retryAt, kinds: done.held.kinds }, { status: 409 });
  if (!done) return NextResponse.json({ error: "no_month_due", nextLookOn: nextLookOn(doc, now) }, { status: 409 });
  return monthsFromRequest(ctx, deps);
}
