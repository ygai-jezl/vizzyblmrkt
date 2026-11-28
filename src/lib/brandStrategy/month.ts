import { listSituations, readSituation } from "@/lib/brandMap/situations";
import { listRecentReadArticles } from "@/lib/competitors/articles";
import { isCompetitorArticlesEnabled, isCompetitorsEnabled } from "@/lib/competitors/flags";
import { listCompetitors } from "@/lib/competitors/store";
import type { ConnectorManifest } from "@/lib/connectors/manifest";
import { readOutcomes, type OutcomeDeps, type OutcomePage, type OutcomeRead } from "@/lib/connectors/outcomes";
import { listConnectors } from "@/lib/connectors/registry";
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
import { isStrategyResultsEnabled, isStrategySuggestEnabled } from "./flags";
import { mondayOfWeek, monthBounds, monthCounts, monthDue, monthLook, previousMonth, weeksIn, withMonth, type MonthArticle, type MonthInput } from "./monthRules";
import { parseBrandStrategy } from "./store";
import { suggestAfterLook } from "./suggestRules";

/**
 * How it went's scheduled side (STRATEGY_RESULTS_ENABLED). It rides the lifecycle tick (every 2
 * minutes, worker secret only) and runs about every 30 minutes, at a tick of its own: offset 4 of
 * 15, so it never adds to the competitors' scan (0), brand search (0, 5, 10), connected data's lane
 * (7) or the weekly check (11). From the 2nd of each month, each run adds up last month for no more
 * than 3 brands with an approved strategy that don't have it yet, the one waiting longest first,
 * within its budget. Every brand with the strategy gets it: no model call, and the connector reads
 * are the brand's own scheduled job. One brand's failure never stops the rest: it is tried again a
 * day later. A connected tool that can't be read holds the month back a day, twice at most; the
 * third look keeps it with that kind marked failed. A month is written once and never changed, on
 * the strategy record without moving its revision. A brand's look starts only with time left for
 * the slowest connector's read (its manifest's timeout, plus a second).
 *
 * With STRATEGY_SUGGEST_ENABLED on, keeping a month also works out the month's one suggestion
 * (suggestRules.ts) from the kept months, the approved strategy, the plan, coverage and the holds, in
 * the same write: a new one replaces the one before, and none applying clears it. Off, nothing but
 * the month is written, exactly as before.
 */

const TICK_MS = 120_000;
const EVERY = 15;
const OFFSET = 4;
const BRANDS_PER_RUN = 3;
/** Below this, no more brands are queued. */
const MIN_LEFT_MS = 3_000;
const RETRY_MS = 86_400_000;
/** Looks held back for a connected tool that couldn't be read, before the month is kept without it. */
export const MAX_HOLDS = 2;
/** With no offered connector to say: the slowest a connector may take (20 s), plus a second. */
const LOOK_FALLBACK_MS = 21_000;

/** The time a brand's look needs left: the slowest offered connector's timeout, plus a second. */
export function lookNeedsMs(catalog: readonly Pick<ConnectorManifest, "api">[]): number {
  const slowest = Math.max(0, ...catalog.map((m) => m.api.timeoutMs ?? 0));
  return slowest > 0 ? slowest + 1_000 : LOOK_FALLBACK_MS;
}

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
  outcomeDeps?: Omit<OutcomeDeps, "db" | "now" | "catalog">;
  /** The connectors offered in this build (registry.ts listConnectors; tests pass their own). */
  catalog?: () => readonly ConnectorManifest[];
}

export interface StrategyMonthResult {
  brands: number;
  /** Brands whose month was kept. */
  kept: number;
  /** Brands whose month waits a day for a connected tool that couldn't be read. */
  held: number;
  failed: number;
}

/** A look's outcome: kept, held back a day for a tool that couldn't be read, or nothing to do. */
export type MonthOutcome = { kept: StrategyMonth } | { held: { retryAt: string; kinds: string[] } } | null;

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
async function roadmapIn(ctx: TenantContext, plan: ContentPlan, month: string, deps: MonthDeps, asOf?: Date): Promise<{ due: number; done: number }> {
  // A month so far (a preview) counts only the weeks that have begun.
  const today = asOf?.toISOString().slice(0, 10);
  const weeks = new Set([...weeksIn(month)].filter((w) => !today || mondayOfWeek(w) <= today));
  const slots = new Map(plan.slots.map((s) => [s.id, s] as const));
  const due = plan.roadmap.filter((e) => e.action === "write" && weeks.has(e.week) && slots.has(e.slotId)).map((e) => slots.get(e.slotId)!);
  if (!due.length) return { due: 0, done: 0 };
  const now = await questionsNow(ctx, due.flatMap((s) => s.questionIds), { db: deps.db });
  return { due: due.length, done: due.filter((s) => s.questionIds.some((q) => now.get(q)?.state === "answered")).length };
}

/**
 * The roadmap's entries to write due by the end of the month (their week began by then) that no live
 * article answers now, each slot once, earliest first: what Behind plan names.
 */
async function behindBy(ctx: TenantContext, plan: ContentPlan, month: string, deps: MonthDeps): Promise<Array<{ slotId: string; title: string }>> {
  const end = monthBounds(month).to;
  const slots = new Map(plan.slots.map((s) => [s.id, s] as const));
  const due = [
    ...new Map(
      plan.roadmap
        .filter((e) => e.action === "write" && slots.has(e.slotId) && mondayOfWeek(e.week) <= end)
        .sort((a, b) => a.week.localeCompare(b.week))
        .map((e) => [e.slotId, slots.get(e.slotId)!] as const),
    ).values(),
  ];
  if (!due.length) return [];
  const now = await questionsNow(ctx, due.flatMap((s) => s.questionIds), { db: deps.db });
  return due.filter((s) => !s.questionIds.some((q) => now.get(q)?.state === "answered")).map((s) => ({ slotId: s.id, title: s.title }));
}

/**
 * What a month's look reads for one brand. A read of the brand's own data that fails throws (an
 * empty list would read as "nothing happened"); a connector's read that fails only leaves its kind
 * out.
 */
export async function monthInput(ctx: TenantContext, tenant: Tenant | null, doc: BrandStrategyDoc, month: string, deps: MonthDeps, now: Date, opts: { soFar?: boolean } = {}): Promise<MonthInput> {
  const approved = doc.approved!;
  const loadTenant = async () => tenant;
  const plans = isContentStrategyEnabled();
  const competitors = isCompetitorsEnabled() && isCompetitorArticlesEnabled() && tenantMayUse(tenant, "competitors") && tenantMayUse(tenant, "competitor_articles");
  const [situations, focus, live, planDoc, theirs] = await Promise.all([
    listSituations(ctx, { db: deps.db }),
    focusOf(ctx, approved.focusSituationIds, deps),
    liveArticles(ctx, deps.db, { strict: true }),
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
    // A person's own choice on the brief first, then the pick it came from, then its question's situation.
    const situationId = (typeof brief?.situationId === "string" ? brief.situationId : null) ?? brief?.basedOn?.situationId ?? (brief?.primaryRef ? (focus.situationOf.get(brief.primaryRef) ?? null) : null);
    byKey.set(key, { article: { key, publishedAt, situationId }, url: a.url });
  }
  const pages = [...byKey.values()].map((v) => ({ key: v.article.key, url: v.url }));
  const outcomes = await (deps.outcomes ?? readOutcomes)(ctx, pages, { ...deps.outcomeDeps, db: deps.db, now, ...(deps.catalog ? { catalog: deps.catalog } : {}) });
  // A plan approved after the month ended had nothing due in it.
  const plan = planDoc?.approved && planDoc.approved.at < monthBounds(month).endIso ? planDoc.approved : null;
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
    roadmap: plan ? await roadmapIn(ctx, plan, month, deps, opts.soFar ? now : undefined) : null,
    // For the month's suggestion only, while its switch is on.
    ...(isStrategySuggestEnabled() && !opts.soFar ? { behind: plan ? await behindBy(ctx, plan, month, deps) : null } : {}),
    decisions: doc.decisions,
    planDecisions: planDoc ? planDoc.decisions : null,
  };
}

/**
 * One brand's month: read, add up, then keep it on the record as it is at the write. A month is
 * written once and never changed. When a connected, shared tool couldn't be read, the month is held
 * back a day instead (MAX_HOLDS times at most); the look after that keeps it with that kind marked
 * failed. Null when there is no approved strategy any more, the month doesn't count (before the
 * first full month after the first approval), or it was kept meanwhile.
 */
export async function lookAtMonth(ctx: TenantContext, tenant: Tenant | null, deps: MonthDeps = {}, opts: { month?: string } = {}): Promise<MonthOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const repo = forTenant(ctx, deps.db).brandStrategy;
  const doc = parseBrandStrategy(await repo.getById(brandStrategyDocId(ctx.tenantId)));
  if (!doc?.approved) return null;
  const month = opts.month ?? previousMonth(now.getTime());
  if (!monthCounts(doc, month)) return null;
  const input = await monthInput(ctx, tenant, doc, month, deps, now);
  const look = monthLook(input);
  const suggestOn = isStrategySuggestEnabled();
  const failedKinds = look.missing.filter((x) => x.why === "failed").map((x) => x.kind);
  let held: { retryAt: string; kinds: string[] } | null = null;
  const kept = await repo.claim(brandStrategyDocId(ctx.tenantId), (current) => {
    held = null;
    const fresh = parseBrandStrategy(current);
    if (!fresh?.approved || fresh.months.some((m) => m.month === month)) return null;
    if (failedKinds.length && fresh.monthsRetries < MAX_HOLDS) {
      held = { retryAt: new Date(now.getTime() + RETRY_MS).toISOString(), kinds: failedKinds };
      return { monthsRetryAt: held.retryAt, monthsRetries: fresh.monthsRetries + 1 };
    }
    return {
      months: withMonth(fresh.months, look),
      monthsRetryAt: null,
      monthsRetries: 0,
      // The month's suggestion, worked out from the record as it is at the write (a Not now that lands meanwhile counts).
      ...(suggestOn ? suggestAfterLook(fresh, look, input, now.toISOString()) : {}),
    };
  });
  if (!kept) return null;
  if (held) return { held };
  const parsed = StrategyMonthSchema.safeParse(look);
  return parsed.success ? { kept: parsed.data } : null;
}

/**
 * This month so far, for an admin's look before it is due (POST map/strategy/month with preview):
 * from the 1st to now, connected results over the last 28 days as of today. Never written.
 */
export async function previewMonth(ctx: TenantContext, tenant: Tenant | null, deps: MonthDeps = {}): Promise<StrategyMonth | null> {
  const now = (deps.now ?? (() => new Date()))();
  const doc = parseBrandStrategy(await forTenant(ctx, deps.db).brandStrategy.getById(brandStrategyDocId(ctx.tenantId)));
  if (!doc?.approved) return null;
  return monthLook(await monthInput(ctx, tenant, doc, now.toISOString().slice(0, 7), deps, now, { soFar: true }));
}

/** After a failed look: try again a day later, so one brand can't hold the queue. */
async function retryLater(ctx: TenantContext, deps: MonthDeps, nowMs: number): Promise<void> {
  await forTenant(ctx, deps.db)
    .brandStrategy.claim(brandStrategyDocId(ctx.tenantId), (current) => (parseBrandStrategy(current)?.approved ? { monthsRetryAt: new Date(nowMs + RETRY_MS).toISOString() } : null))
    .catch(() => null);
}

export async function runStrategyMonths(opts: { deadlineMs: number }, deps: MonthDeps = {}): Promise<StrategyMonthResult> {
  const result: StrategyMonthResult = { brands: 0, kept: 0, held: 0, failed: 0 };
  const clock = () => (deps.now ?? (() => new Date()))().getTime();
  if (!isStrategyResultsEnabled() || !isMonthTick(clock()) || new Date(clock()).getUTCDate() < 2) return result;
  const needs = lookNeedsMs((deps.catalog ?? listConnectors)());
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
    // A look starts only with time for the slowest connector's read, so it never runs past the deadline.
    if (result.brands >= BRANDS_PER_RUN || opts.deadlineMs - Date.now() < needs) break;
    result.brands += 1;
    try {
      const done = await lookAtMonth(ctx, t, deps, { month });
      if (done && "kept" in done) result.kept += 1;
      else if (done && "held" in done) result.held += 1;
    } catch (err) {
      result.failed += 1;
      console.warn(`[strategy-month] ${t.id} (${t.region}) look failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
      await retryLater(ctx, deps, clock());
    }
  }
  return result;
}
