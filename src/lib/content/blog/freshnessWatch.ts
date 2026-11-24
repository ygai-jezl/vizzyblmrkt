import { isBlogFreshnessEnabled, isBrandMapScaleEnabled } from "@/lib/brandMap/flags";
import { listBrandMapPages } from "@/lib/brandMap/pages";
import { subjectCoverage } from "@/lib/brandMap/recount";
import { readBrandMap } from "@/lib/brandMap/store";
import { mayFetch, robotsFor } from "@/lib/competitors/fetch";
import { rolledId } from "@/lib/connectors/keys";
import { articlePageKey, bareHost, freshnessWatchId, signalPageKey } from "./freshnessPages";
import { searchConsoleManifest } from "@/lib/connectors/manifests/searchConsole";
import { openSuggestions, planningConnections } from "@/lib/connectors/signals/review";
import { RULES } from "@/lib/connectors/signals/detect";
import { signalLines } from "@/lib/connectors/signals/words";
import { readSnapshot } from "@/lib/connectors/snapshots";
import { safeFetch } from "@/lib/security/ssrf";
import { forTenant } from "@/lib/tenant";
import { listAllTenants } from "@/lib/tenant/registry";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { listRecentContentPlans, updateContentPlanNode } from "@/lib/tenant/workspaceContent";
import type { BlogArticleFreshness, ContentNode, ContentPlan, FreshnessClock, FreshnessReason } from "@/lib/types/contentPlan";
import type { FreshnessDueItem, FreshnessWatchDoc } from "@/lib/types/freshness";
import type { Tenant } from "@/lib/types/tenant";
import type { BrandMapPage } from "@/lib/types/brandMapPage";
import { computeCoverage } from "./coverage";
import { articleFigures } from "./figures";
import { articleFreshness, assignClock, nextEvents, OLD_SOURCE_YEARS, oldFigureYears } from "./freshness";
import { inlineLinks } from "./markdown";
import { outlineArticle } from "./outline";

/**
 * The freshness watch (BLOG_FRESHNESS_ENABLED): once a day per brand it looks at every live blog
 * article, gives one without a clock its clock, works out its state from counted signals (no AI),
 * writes it on the article, and keeps the brand's due list in `fw_<tenantId>`.
 */

const DAY_MS = 86_400_000;
export const FRESHNESS_WATCH = {
  BRANDS_PER_TICK: 3,
  MIN_LEFT_MS: 5_000,
  PLANS_PER_PROGRAMME: 100,
  MAX_PROGRAMMES: 20,
  MAX_DUE: 20,
  MAX_PAGES: 200,
  /** Outbound links checked per brand per day, and how often an article's links are checked. */
  LINKS_PER_DAY: 50,
  LINK_EVERY_DAYS: 7,
  MAX_LINKS_PER_ARTICLE: 20,
  /** An article's subject with this many open questions counts as having new ones to answer. */
  OPEN_QUESTIONS: 2,
} as const;

export { articlePageKey, bareHost, freshnessWatchId } from "./freshnessPages";

export type LinkState = "ok" | "dead" | "unknown";

export interface FreshnessDeps {
  db?: FirestoreLike;
  listTenants?: () => Promise<Tenant[]>;
  now?: () => Date;
  rand?: () => number;
  /** Search Console's open "losing clicks" suggestions, by page key. */
  losingPages?: (ctx: TenantContext) => Promise<Map<string, string>>;
  /** Search Console's 28-day page positions within reach of page one, by page key. */
  reachPages?: (ctx: TenantContext) => Promise<Map<string, string>>;
  /** Open questions on each of the given subjects. */
  openQuestions?: (ctx: TenantContext, subjectIds: string[]) => Promise<Map<string, number>>;
  checkLink?: (url: string) => Promise<LinkState>;
}

async function defaultLosing(ctx: TenantContext, db?: FirestoreLike): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const s of await openSuggestions(ctx, {}, { db }).catch(() => [])) {
    if (s.row.rule !== "losing_page" || !s.row.label) continue;
    const key = signalPageKey(s.row.key?.host, s.connection.account, s.row.key?.page ?? s.row.label);
    out.set(key, signalLines(s.row)[0] ?? "Search Console: fewer clicks than in the 28 days before.");
  }
  return out;
}

const SEARCH_STREAM = searchConsoleManifest.produces[0]!.stream;

async function defaultReach(ctx: TenantContext, db?: FirestoreLike): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const r = RULES.reach;
  for (const conn of (await planningConnections(ctx, { db }).catch(() => new Map())).values()) {
    if (!conn.collect?.gen && conn.collect?.gen !== 0) continue;
    const doc = await readSnapshot(ctx, rolledId(conn.id, conn.collect.gen, SEARCH_STREAM, "page", "r28"), { db }).catch(() => null);
    for (const row of doc?.rows ?? []) {
      const p = row.m.searchPosition;
      const i = row.m.searchImpressions ?? 0;
      if (typeof p !== "number" || p < r.minPosition || p > r.maxPosition || i < r.minImpressions) continue;
      const key = signalPageKey(row.host, conn.account, row.key);
      out.set(key, `Search Console: position ${Math.round(p)} on average, ${i.toLocaleString("en-US")} impressions in 28 days. A refresh could lift it onto page one.`);
    }
  }
  return out;
}

async function defaultOpenQuestions(ctx: TenantContext, subjectIds: string[], db?: FirestoreLike): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!subjectIds.length) return out;
  const read = await readBrandMap(ctx, db).catch(() => null);
  if (!read || read.state !== "ok") return out;
  if (isBrandMapScaleEnabled() && read.map.moved) {
    for (const id of subjectIds.slice(0, 10)) {
      const cov = await subjectCoverage(ctx, id, { db }).catch(() => null);
      if (cov) out.set(id, cov.coverage.questions.filter((q) => q.state === "open").length);
    }
    return out;
  }
  const rows = await listBrandMapPages(ctx, db).catch(() => [] as BrandMapPage[]);
  for (const s of computeCoverage(read.map, rows).subjects) {
    if (subjectIds.includes(s.id)) out.set(s.id, s.questions.filter((q) => q.state === "open").length);
  }
  return out;
}

/** A link is dead when its site answers 404 or 410. Anything else (a timeout, robots) tells us nothing. */
async function defaultCheckLink(url: string): Promise<LinkState> {
  try {
    const robots = await robotsFor(new URL(url).origin);
    if (!mayFetch(robots, url)) return "unknown";
    const res = await safeFetch(url, { method: "HEAD", headers: { "User-Agent": "YouGrowBot/1.0" } }, { timeoutMs: 5_000, maxRedirects: 3 });
    if (res.status === 404 || res.status === 410) return "dead";
    return res.status < 400 ? "ok" : "unknown";
  } catch {
    return "unknown";
  }
}

/** The article's outbound https links (not to its own site). */
export function outboundLinks(markdown: string, ownHost: string): string[] {
  const own = bareHost(ownHost);
  const out = new Set<string>();
  for (const l of inlineLinks(markdown)) {
    try {
      const u = new URL(l.href);
      if (u.protocol === "https:" && bareHost(u.hostname) !== own) out.add(u.toString());
    } catch {
      // Not an address.
    }
  }
  return [...out].slice(0, FRESHNESS_WATCH.MAX_LINKS_PER_ARTICLE);
}

interface LiveArticle {
  plan: ContentPlan;
  hub: ContentNode;
  url: string;
  key: string | null;
}

async function liveArticles(ctx: TenantContext, db?: FirestoreLike): Promise<LiveArticle[]> {
  const out: LiveArticle[] = [];
  const programmes = (await forTenant(ctx, db).workspaces.find({ where: [], limit: 200 })).filter((w) => !w.archivedAt).slice(0, FRESHNESS_WATCH.MAX_PROGRAMMES);
  for (const ws of programmes) {
    const plans = await listRecentContentPlans(ctx, ws.id, FRESHNESS_WATCH.PLANS_PER_PROGRAMME, db).catch(() => [] as ContentPlan[]);
    for (const plan of plans) {
      if (plan.status === "archived" || plan.topology.hubChannel !== "blog") continue;
      const hub = plan.graph.nodes.find((n) => n.type === "hub" && n.channel === "blog");
      const live = hub?.blog?.live;
      if (!hub || !live || !hub.blog?.dates?.published) continue;
      out.push({ plan, hub, url: live.url, key: articlePageKey(live.url) });
    }
  }
  return out;
}

/** Look at one brand's live articles now: their clocks, their states, and the brand's due list. */
export async function sweepBrand(ctx: TenantContext, tenant: Pick<Tenant, "refreshClock">, deps: FreshnessDeps & { deadlineMs?: number } = {}): Promise<FreshnessWatchDoc> {
  const now = (deps.now ?? (() => new Date()))();
  const db = deps.db;
  const repo = forTenant(ctx, db).freshnessWatch;
  const prior = await repo.getById(freshnessWatchId(ctx.tenantId));
  const today = now.toISOString().slice(0, 10);
  let linksToday = prior?.linksDay === today ? prior.linksToday : 0;

  const articles = await liveArticles(ctx, db);
  const subjects = [...new Set(articles.map((a) => a.plan.blog?.subjectId).filter((s): s is string => Boolean(s)))];
  const [losing, reach, open] = await Promise.all([
    (deps.losingPages ?? ((c) => defaultLosing(c, db)))(ctx).catch(() => new Map<string, string>()),
    (deps.reachPages ?? ((c) => defaultReach(c, db)))(ctx).catch(() => new Map<string, string>()),
    (deps.openQuestions ?? ((c, ids) => defaultOpenQuestions(c, ids, db)))(ctx, subjects).catch(() => new Map<string, number>()),
  ]);
  const checkLink = deps.checkLink ?? defaultCheckLink;

  // The clocks each subject already has, so a new article's clock keeps each subject mixed.
  const clocksBySubject = new Map<string, Partial<Record<FreshnessClock, number>>>();
  for (const a of articles) {
    const c = a.hub.blog?.freshness?.clockDays;
    if (!c) continue;
    const s = a.plan.blog?.subjectId ?? "";
    const counts = clocksBySubject.get(s) ?? {};
    counts[c] = (counts[c] ?? 0) + 1;
    clocksBySubject.set(s, counts);
  }

  const counts = { fresh: 0, soon: 0, due: 0 };
  const byClock: FreshnessWatchDoc["byClock"] = { "20": 0, "30": 0, "45": 0 };
  const due: FreshnessDueItem[] = [];
  const pages: FreshnessWatchDoc["pages"] = [];
  const year = now.getUTCFullYear();

  for (const a of articles) {
    if (deps.deadlineMs && Date.now() > deps.deadlineMs) break;
    const stored = a.hub.blog?.freshness;
    const subject = a.plan.blog?.subjectId ?? "";
    const setting = tenant.refreshClock;
    const fixed = setting === 20 || setting === 30 || setting === 45 ? setting : null;
    const clock = fixed
      ? { clockDays: fixed, arm: "fixed" as const }
      : stored
        ? { clockDays: stored.clockDays, arm: stored.arm }
        : assignClock("test", clocksBySubject.get(subject) ?? {}, deps.rand);
    if (!stored) clocksBySubject.set(subject, { ...(clocksBySubject.get(subject) ?? {}), [clock.clockDays]: ((clocksBySubject.get(subject) ?? {})[clock.clockDays] ?? 0) + 1 });

    // Links: an article's outbound links once a week, within the brand's daily cap.
    let deadLinks = stored?.deadLinks ?? [];
    let linksCheckedAt = stored?.linksCheckedAt ?? null;
    const linksDue = !linksCheckedAt || now.getTime() - Date.parse(linksCheckedAt) >= FRESHNESS_WATCH.LINK_EVERY_DAYS * DAY_MS;
    if (linksDue) {
      const links = outboundLinks(a.hub.body, a.url ? new URL(a.url).hostname : "");
      if (linksToday + links.length <= FRESHNESS_WATCH.LINKS_PER_DAY) {
        const states = await Promise.all(links.map((l) => checkLink(l).catch((): LinkState => "unknown")));
        linksToday += links.length;
        deadLinks = links.filter((_, i) => states[i] === "dead").slice(0, 10);
        linksCheckedAt = now.toISOString();
      }
    }

    const signals: FreshnessReason[] = [];
    if (a.key && losing.has(a.key)) signals.push({ kind: "losing_clicks", detail: losing.get(a.key)!.slice(0, 200), hard: true });
    if (deadLinks.length) signals.push({ kind: "dead_link", detail: `${deadLinks.length} link${deadLinks.length === 1 ? "" : "s"} no longer open${deadLinks.length === 1 ? "s" : ""}`, hard: true });
    const oldYears = oldFigureYears(articleFigures(a.hub.body).map((f) => f.display), now);
    if (oldYears.length) signals.push({ kind: "old_figure", detail: `A figure from ${oldYears.join(", ")}`, hard: true });
    if (a.key && reach.has(a.key)) signals.push({ kind: "within_reach", detail: reach.get(a.key)!.slice(0, 200), hard: false });
    const oldSources = (a.plan.blog?.sources ?? []).filter((s) => s.year !== null && s.year <= year - OLD_SOURCE_YEARS);
    if (oldSources.length) signals.push({ kind: "old_source", detail: `Cites ${oldSources.length} source${oldSources.length === 1 ? "" : "s"} from ${Math.min(...oldSources.map((s) => s.year!))} or earlier`, hard: false });
    const openOnSubject = subject ? (open.get(subject) ?? 0) : 0;
    if (openOnSubject >= FRESHNESS_WATCH.OPEN_QUESTIONS) signals.push({ kind: "new_questions", detail: `${openOnSubject} questions on its subject that no live page answers`, hard: false });
    const pageDates = a.hub.blog?.dates?.page;
    if (pageDates && !pageDates.published && !pageDates.modified) signals.push({ kind: "no_page_date", detail: "Your page shows no date", hard: false });

    const dates = a.hub.blog!.dates!;
    const state = articleFreshness(
      { publishedAt: dates.published?.at ?? null, updatedAt: dates.updated?.at ?? null, checkedAt: stored?.checkedAt ?? null, clockDays: clock.clockDays, signals },
      now,
    );
    if (!state) continue;
    const becameDue = state.state === "due" && stored?.state !== "due";
    const next: BlogArticleFreshness = {
      clockDays: clock.clockDays,
      arm: clock.arm,
      assignedAt: stored?.assignedAt ?? now.toISOString(),
      checkedAt: stored?.checkedAt ?? null,
      state: state.state,
      reasons: state.reasons,
      dueAt: state.dueAt,
      sweptAt: now.toISOString(),
      deadLinks,
      linksCheckedAt,
      events: becameDue ? nextEvents(stored?.events ?? [], { at: now.toISOString(), kind: "due", clockDays: clock.clockDays }) : (stored?.events ?? []),
    };
    await updateContentPlanNode(ctx, a.plan.workspaceId, a.plan.id, a.hub.id, {}, db, {
      // A check made meanwhile wins over this pass's copy of the article.
      setFreshness: (current) => ({ ...next, checkedAt: current?.checkedAt ?? next.checkedAt, events: current && current.events.length > (stored?.events.length ?? 0) ? current.events : next.events }),
    }).catch((err: unknown) => console.warn(`[freshness] ${ctx.tenantId}/${a.plan.id}: ${err instanceof Error ? err.message.slice(0, 160) : "error"}`));

    counts[state.state] += 1;
    byClock[String(clock.clockDays) as "20" | "30" | "45"] += 1;
    if (a.key && pages.length < FRESHNESS_WATCH.MAX_PAGES) pages.push({ key: a.key, planId: a.plan.id, workspaceId: a.plan.workspaceId });
    if (state.state !== "fresh") {
      due.push({
        planId: a.plan.id,
        workspaceId: a.plan.workspaceId,
        title: (outlineArticle(a.hub.body).title || a.plan.name).slice(0, 200),
        url: a.url,
        state: state.state,
        reasons: state.reasons,
        dueAt: state.dueAt,
        clockDays: clock.clockDays,
        subjectId: a.plan.blog?.subjectId ?? null,
      });
    }
  }

  due.sort((x, y) => (x.state === y.state ? x.dueAt.localeCompare(y.dueAt) : x.state === "due" ? -1 : 1));
  const doc: Omit<FreshnessWatchDoc, "id" | "tenantId"> = {
    nextAt: new Date(now.getTime() + DAY_MS).toISOString(),
    counts,
    byClock,
    pages,
    due: due.slice(0, FRESHNESS_WATCH.MAX_DUE),
    linksDay: today,
    linksToday,
    updatedAt: now.toISOString(),
  };
  await repo.upsert(freshnessWatchId(ctx.tenantId), () => doc, () => doc);
  return { id: freshnessWatchId(ctx.tenantId), tenantId: ctx.tenantId, ...doc };
}

export interface FreshnessResult {
  brands: number;
  articles: number;
  due: number;
}

/** The tick's lane: brands not looked at today, a few a tick, within the budget. */
export async function runFreshness(opts: { deadlineMs: number }, deps: FreshnessDeps = {}): Promise<FreshnessResult> {
  const result: FreshnessResult = { brands: 0, articles: 0, due: 0 };
  if (!isBlogFreshnessEnabled()) return result;
  const now = (deps.now ?? (() => new Date()))();
  const tenants = await (deps.listTenants ?? listAllTenants)();
  for (const t of tenants) {
    if (result.brands >= FRESHNESS_WATCH.BRANDS_PER_TICK || opts.deadlineMs - Date.now() < FRESHNESS_WATCH.MIN_LEFT_MS) break;
    if (t.status === "suspended") continue;
    const ctx: TenantContext = { tenantId: t.id, region: t.region, source: "system" };
    try {
      const prior = await forTenant(ctx, deps.db).freshnessWatch.getById(freshnessWatchId(t.id));
      if (prior && Date.parse(prior.nextAt) > now.getTime()) continue;
      result.brands += 1;
      const doc = await sweepBrand(ctx, t, { ...deps, deadlineMs: opts.deadlineMs });
      result.articles += doc.counts.fresh + doc.counts.soon + doc.counts.due;
      result.due += doc.counts.due;
    } catch (err) {
      console.warn(`[freshness] ${t.id} failed:`, err instanceof Error ? err.message.slice(0, 200) : "error");
    }
  }
  return result;
}
