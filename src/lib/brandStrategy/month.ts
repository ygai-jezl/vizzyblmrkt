import { listSituations, readSituation } from "@/lib/brandMap/situations";
import { listRecentReadArticles } from "@/lib/competitors/articles";
import { isCompetitorArticlesEnabled, isCompetitorsEnabled } from "@/lib/competitors/flags";
import { listCompetitors } from "@/lib/competitors/store";
import { readOutcomes, type OutcomeDeps, type OutcomePage, type OutcomeRead } from "@/lib/connectors/outcomes";
import { articlePageKey, liveArticles } from "@/lib/content/blog/freshnessPages";
import { isContentStrategyEnabled } from "@/lib/contentStrategy/flags";
import { questionsNow } from "@/lib/contentStrategy/questions";
import { readContentStrategyDoc } from "@/lib/contentStrategy/store";
import { tenantMayUse } from "@/lib/plans/brandAccess";
import { forTenant } from "@/lib/tenant";
import { listAllTenants } from "@/lib/tenant/registry";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { brandStrategyDocId, StrategyMonthSchema, type BrandStrategyDoc, type StrategyMonth } from "@/lib/types/brandStrategy";
import type { ContentPlan, ContentStrategyDoc } from "@/lib/types/contentStrategy";
import type { Tenant } from "@/lib/types/tenant";
import { isStrategyResultsEnabled } from "./flags";
import { monthBounds, monthDue, monthLook, previousMonth, weeksIn, withMonth, type MonthArticle, type MonthInput } from "./monthRules";
import { parseBrandStrategy } from "./store";

/**
 * How it went's scheduled side (STRATEGY_RESULTS_ENABLED). It rides the lifecycle tick (every 2
 * minutes, worker secret only) and runs about every 30 minutes, at a tick of its own: offset 4 of
 * 15, so it never adds to the competitors' scan (0), brand search (0, 5, 10), connected data's lane
 * (7) or the weekly check (11). From the 2nd of each month, each run adds up last month for no more
 * than 3 brands with an approved strategy that don't have it yet, the one waiting longest first,
 * within its budget. Every brand with the strategy gets it: no model call, and the connector reads
 * are the brand's own scheduled job. One brand's failure never stops the rest: it is tried again a
 * day later. The month is kept on the strategy record without moving its revision.
 */

const TICK_MS = 120_000;
const EVERY = 15;
const OFFSET = 4;
const BRANDS_PER_RUN = 3;
/** Below this, nothing more is started. */
const MIN_LEFT_MS = 3_000;
const RETRY_MS = 86_400_000;

export function isMonthTick(nowMs: number): boolean {
  return Math.floor(nowMs / TICK_MS) % EVERY === OFFSET;
}

export interface MonthDeps {
  db?: FirestoreLike;
  now?: () => Date;
  listTenants?: () => Promise<Tenant[]>;
  /** The kinds of result on the brand's pages (connectors/outcomes.ts readOutcomes; tests pass their own). */
  outcomes?: (ctx: TenantContext, pages: readonly OutcomePage[], deps: OutcomeDeps) => Promise<OutcomeRead>;
  /** Passed to readOutcomes. */
  outcomeDeps?: Omit<OutcomeDeps, "db" | "now">;
}

export interface StrategyMonthResult {
  brands: number;
  /** Brands whose month was kept. */
  kept: number;
  failed: number;
}

const ctxOf = (t: Tenant): TenantContext => ({ tenantId: t.id, region: t.region, source: "system" });

/** The focus situations read whole: their questions (by question id, to place an article written for one) and their counts now. */
async function focusOf(ctx: TenantContext, ids: readonly string[], deps: MonthDeps): Promise<{ situationOf: Map<string, string>; counts: Map<string, { questions: number; answered: number }> }> {
  const situationOf = new Map<string, string>();
  const counts = new Map<string, { questions: number; answered: number }>();
  for (const id of ids) {
    const read = await readSituation(ctx, id, { db: deps.db });
    if (!read) continue;
    counts.set(id, read.situation.counts);
    for (const q of read.questions) if (q.status === "decided" && !situationOf.has(q.id)) situationOf.set(q.id, id);
  }
  return { situationOf, counts };
}

/** The roadmap's entries to write that were due in the month, and how many of them a live article now answers. */
async function roadmapIn(ctx: TenantContext, plan: ContentPlan, month: string, deps: MonthDeps): Promise<{ due: number; done: number }> {
  const weeks = weeksIn(month);
  const slots = new Map(plan.slots.map((s) => [s.id, s] as const));
  const due = plan.roadmap.filter((e) => e.action === "write" && weeks.has(e.week) && slots.has(e.slotId)).map((e) => slots.get(e.slotId)!);
  if (!due.length) return { due: 0, done: 0 };
  const now = await questionsNow(ctx, due.flatMap((s) => s.questionIds), { db: deps.db });
  return { due: due.length, done: due.filter((s) => s.questionIds.some((q) => now.get(q)?.state === "answered")).length };
}

/**
 * What a month's look reads for one brand. A read of the brand's own data that fails throws (an
 * empty list would read as "nothing happened"); a connector's read that fails only leaves its kind
 * out.
 */
export async function monthInput(ctx: TenantContext, tenant: Tenant | null, doc: BrandStrategyDoc, month: string, deps: MonthDeps, now: Date): Promise<MonthInput> {
  const approved = doc.approved!;
  const loadTenant = async () => tenant;
  const plans = isContentStrategyEnabled();
  const competitors = isCompetitorsEnabled() && isCompetitorArticlesEnabled() && tenantMayUse(tenant, "competitors") && tenantMayUse(tenant, "competitor_articles");
  const [situations, focus, live, planDoc, theirs] = await Promise.all([
    listSituations(ctx, { db: deps.db }),
    focusOf(ctx, approved.focusSituationIds, deps),
    liveArticles(ctx, deps.db),
    plans ? readContentStrategyDoc(ctx, { db: deps.db }) : Promise.resolve(null as ContentStrategyDoc | null),
    competitors
      ? Promise.all([listRecentReadArticles(ctx, { db: deps.db, now: () => now, loadTenant }), listCompetitors(ctx, { db: deps.db })]).then(([recent, watched]) => {
          const ids = new Set(watched.map((c) => c.id));
          return recent.articles.filter((a) => ids.has(a.competitorId)).map((a) => ({ publishedAt: a.publishedAt, situationIds: a.situationIds }));
        })
      : Promise.resolve(null),
  ]);
  // One page each: two plans live at one address count once, the first found.
  const byKey = new Map<string, { article: MonthArticle; url: string }>();
  for (const a of live) {
    const key = a.key ?? articlePageKey(a.url);
    const publishedAt = a.hub.blog?.dates?.published?.at;
    if (!key || !publishedAt || byKey.has(key)) continue;
    const brief = a.plan.blog;
    const situationId = brief?.basedOn?.situationId ?? (typeof brief?.situationId === "string" ? brief.situationId : null) ?? (brief?.primaryRef ? (focus.situationOf.get(brief.primaryRef) ?? null) : null);
    byKey.set(key, { article: { key, publishedAt, situationId }, url: a.url });
  }
  const pages = [...byKey.values()].map((v) => ({ key: v.article.key, url: v.url }));
  const outcomes = await (deps.outcomes ?? readOutcomes)(ctx, pages, { ...deps.outcomeDeps, db: deps.db, now });
  const plan = planDoc?.approved ?? null;
  return {
    month,
    nowIso: now.toISOString(),
    approved: { at: approved.at, focusSituationIds: approved.focusSituationIds },
    plan: plan ? { at: plan.at } : null,
    // A focus situation's counts as just read with its questions; the rest as stored.
    situations: situations.filter((s) => s.status === "decided").map((s) => ({ id: s.id, text: s.text, ...(focus.counts.get(s.id) ?? s.counts) })),
    articles: [...byKey.values()].map((v) => v.article),
    outcomes,
    theirs,
    roadmap: plan ? await roadmapIn(ctx, plan, month, deps) : null,
    decisions: doc.decisions,
    planDecisions: planDoc ? planDoc.decisions : null,
  };
}

/**
 * One brand's month: read, add up, then keep it on the record as it is at the write. The tick never
 * writes a month that is kept already; `replace` (the run by hand) puts it in place of the kept one.
 * Answers the month kept, or null when there is no approved strategy any more or it was kept
 * meanwhile.
 */
export async function lookAtMonth(ctx: TenantContext, tenant: Tenant | null, deps: MonthDeps = {}, opts: { month?: string; replace?: boolean } = {}): Promise<StrategyMonth | null> {
  const now = (deps.now ?? (() => new Date()))();
  const repo = forTenant(ctx, deps.db).brandStrategy;
  const doc = parseBrandStrategy(await repo.getById(brandStrategyDocId(ctx.tenantId)));
  if (!doc?.approved) return null;
  const month = opts.month ?? previousMonth(now.getTime());
  // A strategy approved after the month ended has nothing to say about it.
  if (!(Date.parse(doc.approved.at) < Date.parse(monthBounds(month).endIso))) return null;
  const look = monthLook(await monthInput(ctx, tenant, doc, month, deps, now));
  const kept = await repo.claim(brandStrategyDocId(ctx.tenantId), (current) => {
    const fresh = parseBrandStrategy(current);
    if (!fresh?.approved) return null;
    if (!opts.replace && fresh.months.some((m) => m.month === month)) return null;
    return { months: withMonth(fresh.months, look), monthsRetryAt: null };
  });
  if (!kept) return null;
  const parsed = StrategyMonthSchema.safeParse(look);
  return parsed.success ? parsed.data : null;
}

/** After a failed look: try again a day later, so one brand can't hold the queue. */
async function retryLater(ctx: TenantContext, deps: MonthDeps, nowMs: number): Promise<void> {
  await forTenant(ctx, deps.db)
    .brandStrategy.claim(brandStrategyDocId(ctx.tenantId), (current) => (parseBrandStrategy(current)?.approved ? { monthsRetryAt: new Date(nowMs + RETRY_MS).toISOString() } : null))
    .catch(() => null);
}

export async function runStrategyMonths(opts: { deadlineMs: number }, deps: MonthDeps = {}): Promise<StrategyMonthResult> {
  const result: StrategyMonthResult = { brands: 0, kept: 0, failed: 0 };
  const clock = () => (deps.now ?? (() => new Date()))().getTime();
  if (!isStrategyResultsEnabled() || !isMonthTick(clock()) || new Date(clock()).getUTCDate() < 2) return result;
  const tenants = (await (deps.listTenants ?? listAllTenants)()).filter((t) => t.status !== "suspended");
  const queue: Array<{ t: Tenant; ctx: TenantContext; month: string; at: number }> = [];
  for (const t of tenants) {
    if (opts.deadlineMs - Date.now() < MIN_LEFT_MS) break;
    const ctx = ctxOf(t);
    try {
      const doc = parseBrandStrategy(await forTenant(ctx, deps.db).brandStrategy.getById(brandStrategyDocId(t.id)));
      const month = doc ? monthDue(doc, clock()) : null;
      if (!doc || !month) continue;
      const at = doc.monthsRetryAt ? Date.parse(doc.monthsRetryAt) : 0;
      queue.push({ t, ctx, month, at: Number.isFinite(at) ? at : 0 });
    } catch (err) {
      console.warn(`[strategy-month] ${t.id} (${t.region}) read failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
    }
  }
  queue.sort((x, y) => x.at - y.at);
  for (const { t, ctx, month } of queue) {
    if (result.brands >= BRANDS_PER_RUN || opts.deadlineMs - Date.now() < MIN_LEFT_MS) break;
    result.brands += 1;
    try {
      if (await lookAtMonth(ctx, t, deps, { month })) result.kept += 1;
    } catch (err) {
      result.failed += 1;
      console.warn(`[strategy-month] ${t.id} (${t.region}) look failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
      await retryLater(ctx, deps, clock());
    }
  }
  return result;
}
