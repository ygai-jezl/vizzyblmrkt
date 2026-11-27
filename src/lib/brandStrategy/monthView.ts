import { NextResponse } from "next/server";
import { listSituations } from "@/lib/brandMap/situations";
import { liveCoverage, type OutcomeDeps } from "@/lib/connectors/outcomes";
import type { KindCoverage } from "@/lib/metrics/outcomes";
import { getTenantById } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { BrandMapSituation } from "@/lib/types/brandMapRecords";
import { MONTH_REST_ID, type MonthRow, type StrategyMonth } from "@/lib/types/brandStrategy";
import type { Tenant } from "@/lib/types/tenant";
import { lookAtMonth, type MonthDeps } from "./month";
import { GONE_TEXT, REST_TEXT, monthBounds, monthDue, previousMonth, tooEarly } from "./monthRules";
import { readBrandStrategyDoc } from "./store";

/**
 * How it went on the Strategy tab (STRATEGY_RESULTS_ENABLED): the months kept on the strategy
 * record, each row with its situation's words read from the brand map now, and what each kind of
 * result can be measured from now (live coverage, no numbers read). Any member reads it; an admin can
 * add up last month again by hand (the dev check), which reads the brand's own connections now.
 */

export { GONE_TEXT, REST_TEXT };

export type ShownMonth = Omit<StrategyMonth, "rows"> & { rows: Array<MonthRow & { text: string }> };

export interface StrategyMonthsView {
  approvedAt: string | null;
  /** Less than a full month since approval. */
  tooEarly: boolean;
  /** The day the next month is added up (YYYY-MM-DD): the 2nd of next month. */
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

/** When the next month is added up: today when one is due now, else the 2nd of the next month (or of this one, on the 1st). */
const nextLookOn = (doc: Parameters<typeof monthDue>[0] | null, nowMs: number) => {
  const d = new Date(nowMs);
  if (doc && monthDue(doc, nowMs)) return d.toISOString().slice(0, 10);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + (d.getUTCDate() < 2 ? 0 : 1), 2)).toISOString().slice(0, 10);
};

export async function strategyMonthsView(ctx: TenantContext, deps: MonthViewDeps = {}): Promise<StrategyMonthsView> {
  const now = (deps.now ?? (() => new Date()))().getTime();
  const [doc, situations, measuring] = await Promise.all([
    readBrandStrategyDoc(ctx, { db: deps.db }),
    listSituations(ctx, { db: deps.db }).catch(() => [] as BrandMapSituation[]),
    liveCoverage(ctx, { db: deps.db, catalog: deps.catalog }),
  ]);
  const approvedAt = doc?.approved?.at ?? null;
  // Too early counts from the first approval kept, so approving a change later never hides the months.
  const firstAt = approvedAt ? [approvedAt, ...(doc?.history ?? []).map((h) => h.at)].filter(Boolean).sort()[0]! : null;
  return { approvedAt, tooEarly: tooEarly(firstAt, now), nextLookOn: nextLookOn(doc, now), months: shownMonths(doc?.months ?? [], situations), measuring };
}

/** GET map/strategy/month: any member reads it. */
export async function monthsFromRequest(ctx: TenantContext, deps: MonthViewDeps = {}): Promise<Response> {
  return NextResponse.json({ howItWent: await strategyMonthsView(ctx, deps) }, { headers: noStore });
}

/**
 * POST map/strategy/month (admins): add up last month for the caller's own brand now, in place of
 * the one kept. 409 `no_month` when there is no strategy approved before this month began.
 */
export async function runMonthFromRequest(ctx: TenantContext, deps: MonthDeps & { loadTenant?: (id: string) => Promise<Tenant | null> } = {}): Promise<Response> {
  const tenant = await (deps.loadTenant ?? getTenantById)(ctx.tenantId).catch(() => null);
  const month = await lookAtMonth(ctx, tenant, deps, { replace: true });
  if (!month) {
    const now = (deps.now ?? (() => new Date()))().getTime();
    return NextResponse.json({ error: "no_month", month: previousMonth(now), from: monthBounds(previousMonth(now)).from }, { status: 409 });
  }
  return monthsFromRequest(ctx, deps);
}
