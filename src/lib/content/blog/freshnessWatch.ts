import { isBlogFreshnessEnabled, isBlogRefreshEnabled, isBrandMapScaleEnabled } from "@/lib/brandMap/flags";
import { listBrandMapPages } from "@/lib/brandMap/pages";
import { subjectCoverage } from "@/lib/brandMap/recount";
import { readBrandMap } from "@/lib/brandMap/store";
import { mayFetch, robotsFor } from "@/lib/competitors/fetch";
import { rolledId } from "@/lib/connectors/keys";
import { bareHost, freshnessWatchId, fromSearchConsole, LIVE_ARTICLES, liveArticles, signalPageKey, withoutSearchConsole } from "./freshnessPages";
import type { LiveArticle } from "./freshnessPages";
import { searchConsoleManifest } from "@/lib/connectors/manifests/searchConsole";
import { openSuggestions, planningConnections } from "@/lib/connectors/signals/review";
import { RULES } from "@/lib/connectors/signals/detect";
import { signalLines } from "@/lib/connectors/signals/words";
import { readSnapshot } from "@/lib/connectors/snapshots";
import { safeFetch } from "@/lib/security/ssrf";
import { forTenant } from "@/lib/tenant";
import { listAllTenants } from "@/lib/tenant/registry";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { updateContentPlanNode } from "@/lib/tenant/workspaceContent";
import type { BlogArticleFreshness, FreshnessClock, FreshnessReason } from "@/lib/types/contentPlan";
import type { FreshnessDueItem, FreshnessWatchDoc } from "@/lib/types/freshness";
import type { Tenant } from "@/lib/types/tenant";
import type { BrandMapPage } from "@/lib/types/brandMapPage";
import { computeCoverage } from "./coverage";
import { articleFreshness, assignClock, inNewArticleGrace, nextEvents, OLD_SOURCE_YEARS, oldFigureYears } from "./freshness";
import { nextDates } from "./dates";
import { fetchSourcePage } from "./research";
import { inlineLinks } from "./markdown";
import { outlineArticle } from "./outline";

/**
 * The freshness watch (BLOG_FRESHNESS_ENABLED): once a day per brand it looks at every live blog
 * article, gives one without a clock its clock, works out its state from counted signals (no AI),
 * writes it on the article, and keeps the brand's due list in `fw_<tenantId>`. A look its tick's
 * time cuts short is due again at the next tick and goes on with the articles it didn't reach; until
 * then each keeps its last state, and its row on the due list. A tick cut before it reached any
 * article waits a while instead, so a brand slow to read never takes every tick, and the brands
 * waiting longest are looked at first.
 */

const DAY_MS = 86_400_000;
export const FRESHNESS_WATCH = {
  BRANDS_PER_TICK: 3,
  MIN_LEFT_MS: 5_000,
  PLANS_PER_PROGRAMME: LIVE_ARTICLES.PLANS_PER_PROGRAMME,
  MAX_PROGRAMMES: LIVE_ARTICLES.MAX_PROGRAMMES,
  MAX_DUE: 20,
  MAX_PAGES: 200,
  /** Outbound links checked per brand per day, and how often an article's links are checked. */
  LINKS_PER_DAY: 50,
  LINK_EVERY_DAYS: 7,
  MAX_LINKS_PER_ARTICLE: 20,
  /** This many more open questions on an article's subject than when its clock started counts as new ones to answer. */
  OPEN_QUESTIONS: 2,
  /** How long a look waits when its tick ran out of time before it reached any article. */
  EMPTY_CUT_WAIT_MS: 30 * 60_000,
  /** Refreshed articles whose page is read again for its dates, per brand per look (BLOG_REFRESH_ENABLED). */
  PAGE_BEHIND_PER_DAY: 10,
} as const;

/** Said when a refreshed article's live page doesn't show its new Updated date yet. */
export const PAGE_BEHIND_SAID = "Your page doesn't show the update yet. Republish it with the new copy and date.";

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
  /** The dates a live page gives itself (null when it can't be read). */
  pageDates?: (url: string) => Promise<{ published: string | null; modified: string | null } | null>;
}

async function defaultPageDates(url: string): Promise<{ published: string | null; modified: string | null } | null> {
  const page = await fetchSourcePage(url);
  if (!page || page.refused) return null;
  return page.dates ?? { published: null, modified: null };
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
export async function checkLinkState(url: string): Promise<LinkState> {
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

/** An article's row on the due list. */
function dueRow(a: LiveArticle, f: Pick<FreshnessDueItem, "state" | "reasons" | "dueAt" | "clockDays">): FreshnessDueItem {
  return {
    planId: a.plan.id,
    workspaceId: a.plan.workspaceId,
    title: (outlineArticle(a.hub.body).title || a.plan.name).slice(0, 200),
    url: a.url,
    state: f.state,
    reasons: f.reasons,
    dueAt: f.dueAt,
    clockDays: f.clockDays,
    subjectId: a.plan.blog?.subjectId ?? null,
  };
}

/** Look at one brand's live articles now: their clocks, their states, and the brand's due list. */
export async function sweepBrand(ctx: TenantContext, tenant: Pick<Tenant, "refreshClock" | "refreshKeepTesting">, deps: FreshnessDeps & { deadlineMs?: number } = {}): Promise<FreshnessWatchDoc> {
  const now = (deps.now ?? (() => new Date()))();
  const db = deps.db;
  const repo = forTenant(ctx, db).freshnessWatch;
  const prior = await repo.getById(freshnessWatchId(ctx.tenantId));
  const today = now.toISOString().slice(0, 10);
  let linksToday = prior?.linksDay === today ? prior.linksToday : 0;
  let pageBehindReads = 0;
  // An erase that takes Search Console's figures out while this look runs moves the record's count
  // on (freshnessErase.ts). This look read those figures before it, so from then on it writes none.
  // A read that fails can't tell, so that article gets none either.
  const clearsAtStart = prior?.searchConsoleClears ?? 0;
  let searchConsoleErased = false;
  const erasedSinceStart = async () => {
    if (searchConsoleErased) return true;
    const stored = await repo.getById(freshnessWatchId(ctx.tenantId)).then(
      (d) => d,
      () => "failed" as const,
    );
    if (stored === "failed") return true;
    searchConsoleErased = (stored?.searchConsoleClears ?? 0) !== clearsAtStart;
    return searchConsoleErased;
  };

  const articles = await liveArticles(ctx, db);
  const subjects = [...new Set(articles.map((a) => a.plan.blog?.subjectId).filter((s): s is string => Boolean(s)))];
  const [losing, reach, open] = await Promise.all([
    (deps.losingPages ?? ((c) => defaultLosing(c, db)))(ctx).catch(() => new Map<string, string>()),
    (deps.reachPages ?? ((c) => defaultReach(c, db)))(ctx).catch(() => new Map<string, string>()),
    (deps.openQuestions ?? ((c, ids) => defaultOpenQuestions(c, ids, db)))(ctx, subjects).catch(() => new Map<string, number>()),
  ]);
  const checkLink = deps.checkLink ?? checkLinkState;

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
  // Every live article's page, whether this tick reaches it or not.
  const pages: FreshnessWatchDoc["pages"] = articles
    .flatMap((a) => (a.key ? [{ key: a.key, planId: a.plan.id, workspaceId: a.plan.workspaceId }] : []))
    .slice(0, FRESHNESS_WATCH.MAX_PAGES);
  const year = now.getUTCFullYear();

  // A look its tick's time cut short goes on where it stopped, unless it began over a day ago.
  const started = prior?.lookStartedAt ?? null;
  const going = started && now.getTime() - Date.parse(started) < DAY_MS ? started : null;
  const rows = new Map((prior?.due ?? []).map((d) => [d.planId, d]));
  let cut = false;
  // Articles this tick looked at itself.
  let looked = 0;
  // This tick wrote a Search Console reason on an article, so an erase starts the look over.
  let wroteSearchConsole = false;
  // An article this tick doesn't work out counts as it last was, and keeps its row on the due list:
  // the last list's, or, when that list had no room for it, one made from its stored state.
  const keep = (a: LiveArticle, f: BlogArticleFreshness) => {
    counts[f.state] += 1;
    byClock[String(f.clockDays) as "20" | "30" | "45"] += 1;
    if (f.state !== "fresh") due.push(rows.get(a.plan.id) ?? dueRow(a, { ...f, state: f.state }));
  };

  for (const a of articles) {
    const stored = a.hub.blog?.freshness;
    // Looked at earlier in this look, or out of time: as it last was.
    const lookedBefore = Boolean(going && stored && Date.parse(stored.sweptAt) >= Date.parse(going));
    if (!lookedBefore && deps.deadlineMs && Date.now() > deps.deadlineMs) cut = true;
    if (lookedBefore || cut) {
      if (stored) keep(a, stored);
      continue;
    }
    looked += 1;
    const subject = a.plan.blog?.subjectId ?? "";
    const setting = tenant.refreshClock;
    const fixed = setting === 20 || setting === 30 || setting === 45 ? setting : null;
    // A fixed clock accepted from the readout keeps a tenth of new articles testing; one already in the test stays.
    const keepTesting = Boolean(fixed && tenant.refreshKeepTesting && isBlogRefreshEnabled());
    const testing = keepTesting && (stored ? stored.arm === "test" : (deps.rand ?? Math.random)() < 0.1);
    const clock = fixed && !testing
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

    // Search Console's figures only while no erase took them out since this look began, checked
    // just before they are written.
    const searchConsole = Boolean(a.key && (losing.has(a.key) || reach.has(a.key))) && !(await erasedSinceStart());
    const signals: FreshnessReason[] = [];
    if (searchConsole && losing.has(a.key!)) signals.push({ kind: "losing_clicks", detail: losing.get(a.key!)!.slice(0, 200), hard: true });
    if (deadLinks.length) signals.push({ kind: "dead_link", detail: `${deadLinks.length} link${deadLinks.length === 1 ? "" : "s"} no longer open${deadLinks.length === 1 ? "s" : ""}`, hard: true });
    // A new or just updated article: its figures and sources were chosen days ago (NEW_ARTICLE_GRACE_DAYS).
    const settling = inNewArticleGrace({ publishedAt: a.hub.blog?.dates?.published?.at ?? null, updatedAt: a.hub.blog?.dates?.updated?.at ?? null }, now);
    const oldYears = settling ? [] : oldFigureYears(a.hub.body, now);
    if (oldYears.length) signals.push({ kind: "old_figure", detail: `A figure from ${oldYears.join(", ")}`, hard: true });
    if (searchConsole && reach.has(a.key!)) signals.push({ kind: "within_reach", detail: reach.get(a.key!)!.slice(0, 200), hard: false });
    const oldSources = settling ? [] : (a.plan.blog?.sources ?? []).filter((s) => s.year !== null && s.year <= year - OLD_SOURCE_YEARS);
    if (oldSources.length) signals.push({ kind: "old_source", detail: `Cites ${oldSources.length} source${oldSources.length === 1 ? "" : "s"} from ${Math.min(...oldSources.map((s) => s.year!))} or earlier`, hard: false });
    // New questions: open ones on its subject past the count when its clock started (set at the first look after).
    const openNow = subject && open.has(subject) ? open.get(subject)! : null;
    const openAtStart = stored?.openAtStart ?? openNow;
    const newOnes = openNow !== null && openAtStart !== null ? openNow - openAtStart : 0;
    if (newOnes >= FRESHNESS_WATCH.OPEN_QUESTIONS) signals.push({ kind: "new_questions", detail: `${newOnes} new questions on its subject that no live page answers`, hard: false });
    const pageDates = a.hub.blog?.dates?.page;
    if (pageDates && !pageDates.published && !pageDates.modified) signals.push({ kind: "no_page_date", detail: "Your page shows no date", hard: false });

    let dates = a.hub.blog!.dates!;
    // A refresh moved Updated (BLOG_REFRESH_ENABLED): read the page again until it shows that day.
    if (isBlogRefreshEnabled() && dates.updated?.source === "change" && a.url && pageBehindReads < FRESHNESS_WATCH.PAGE_BEHIND_PER_DAY) {
      pageBehindReads += 1;
      const read = await (deps.pageDates ?? defaultPageDates)(a.url).catch(() => null);
      if (read) {
        const next = nextDates(dates, { page: read, now });
        if (next.updated?.source === "change") signals.push({ kind: "page_behind", detail: PAGE_BEHIND_SAID, hard: false });
        await updateContentPlanNode(ctx, a.plan.workspaceId, a.plan.id, a.hub.id, { made: { unstamped: "dates_only" } }, db, { setDates: (current) => (current ? nextDates(current, { page: read, now }) : current) }).catch(() => null);
        dates = next;
      }
    }
    const state = articleFreshness(
      { publishedAt: dates.published?.at ?? null, updatedAt: dates.updated?.at ?? null, checkedAt: stored?.checkedAt ?? null, clockDays: clock.clockDays, signals },
      now,
    );
    if (!state) continue;
    if (fromSearchConsole(state.reasons)) wroteSearchConsole = true;
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
      openAtStart,
      events: becameDue ? nextEvents(stored?.events ?? [], { at: now.toISOString(), kind: "due", clockDays: clock.clockDays }) : (stored?.events ?? []),
    };
    await updateContentPlanNode(ctx, a.plan.workspaceId, a.plan.id, a.hub.id, { made: { unstamped: "dates_only" } }, db, {
      // A check made meanwhile wins over this pass's copy of the article.
      setFreshness: (current) => {
        const checkedMeanwhile = Boolean(current && current.checkedAt !== (stored?.checkedAt ?? null));
        return {
          ...next,
          checkedAt: current?.checkedAt ?? next.checkedAt,
          // A check restarts the clock, so the next look counts open questions afresh.
          openAtStart: checkedMeanwhile ? (current?.openAtStart ?? null) : next.openAtStart,
          events: current && current.events.length > (stored?.events.length ?? 0) ? current.events : next.events,
        };
      },
    }).catch((err: unknown) => console.warn(`[freshness] ${ctx.tenantId}/${a.plan.id}: ${err instanceof Error ? err.message.slice(0, 160) : "error"}`));

    counts[state.state] += 1;
    byClock[String(clock.clockDays) as "20" | "30" | "45"] += 1;
    if (state.state !== "fresh") due.push(dueRow(a, { state: state.state, reasons: state.reasons, dueAt: state.dueAt, clockDays: clock.clockDays }));
  }

  due.sort((x, y) => (x.state === y.state ? x.dueAt.localeCompare(y.dueAt) : x.state === "due" ? -1 : 1));
  const doc: Omit<FreshnessWatchDoc, "id" | "tenantId"> = {
    // Cut short: due again at the next tick, to go on where it stopped; after a while if this tick
    // reached no article, so its reads don't take every tick and hold up the brands after it.
    nextAt: new Date(now.getTime() + (!cut ? DAY_MS : looked ? 0 : FRESHNESS_WATCH.EMPTY_CUT_WAIT_MS)).toISOString(),
    lookStartedAt: cut ? (going ?? now.toISOString()) : null,
    searchConsoleInLook: cut && (wroteSearchConsole || Boolean(going && prior?.searchConsoleInLook)),
    counts,
    byClock,
    pages,
    due: due.slice(0, FRESHNESS_WATCH.MAX_DUE),
    linksDay: today,
    linksToday,
    updatedAt: now.toISOString(),
  };
  let written = doc;
  await repo.upsert(
    freshnessWatchId(ctx.tenantId),
    () => doc,
    (current) => {
      written = doc;
      if ((current.searchConsoleClears ?? 0) === clearsAtStart) return doc;
      // An erase took Search Console's figures out while this look ran: none of them on the list, the
      // erase's "due now" kept, and a look cut short that wrote any starts over, so the next look
      // looks again at every article and puts back what is still readable.
      written = {
        ...doc,
        due: doc.due.map((d) => ({ ...d, reasons: withoutSearchConsole(d.reasons) })),
        nextAt: Date.parse(current.nextAt) < Date.parse(doc.nextAt) ? current.nextAt : doc.nextAt,
        ...(doc.searchConsoleInLook ? { lookStartedAt: null } : {}),
        searchConsoleInLook: false,
      };
      return written;
    },
  );
  return { id: freshnessWatchId(ctx.tenantId), tenantId: ctx.tenantId, ...written };
}

export interface FreshnessResult {
  brands: number;
  articles: number;
  due: number;
}

/**
 * The tick's lane: brands due a look, a few a tick, within the budget, the one waiting longest first
 * (never looked at, then the earliest `nextAt`). A look going on is due from the tick before, so it
 * gives way to a brand that has waited since yesterday.
 */
export async function runFreshness(opts: { deadlineMs: number }, deps: FreshnessDeps = {}): Promise<FreshnessResult> {
  const result: FreshnessResult = { brands: 0, articles: 0, due: 0 };
  if (!isBlogFreshnessEnabled()) return result;
  const now = (deps.now ?? (() => new Date()))();
  const tenants = await (deps.listTenants ?? listAllTenants)();
  const queue: Array<{ t: Tenant; ctx: TenantContext; at: number }> = [];
  for (const t of tenants) {
    if (opts.deadlineMs - Date.now() < FRESHNESS_WATCH.MIN_LEFT_MS) break;
    if (t.status === "suspended") continue;
    const ctx: TenantContext = { tenantId: t.id, region: t.region, source: "system" };
    try {
      const prior = await forTenant(ctx, deps.db).freshnessWatch.getById(freshnessWatchId(t.id));
      const at = prior ? Date.parse(prior.nextAt) : 0;
      if (at > now.getTime()) continue;
      queue.push({ t, ctx, at: Number.isFinite(at) ? at : 0 });
    } catch (err) {
      console.warn(`[freshness] ${t.id} failed:`, err instanceof Error ? err.message.slice(0, 200) : "error");
    }
  }
  queue.sort((x, y) => x.at - y.at);
  for (const { t, ctx } of queue) {
    if (result.brands >= FRESHNESS_WATCH.BRANDS_PER_TICK || opts.deadlineMs - Date.now() < FRESHNESS_WATCH.MIN_LEFT_MS) break;
    try {
      result.brands += 1;
      const doc = await sweepBrand(ctx, t, { ...deps, deadlineMs: opts.deadlineMs });
      // Refreshes whose 28 days after are final get their Search Console results (BLOG_REFRESH_ENABLED),
      // once a look has finished, not at each tick of one going on.
      if (isBlogRefreshEnabled() && !doc.lookStartedAt) {
        const { measureOutcomes } = await import("./refreshOutcome");
        await measureOutcomes(ctx, { db: deps.db, now: deps.now }).catch(() => 0);
      }
      result.articles += doc.counts.fresh + doc.counts.soon + doc.counts.due;
      result.due += doc.counts.due;
    } catch (err) {
      console.warn(`[freshness] ${t.id} failed:`, err instanceof Error ? err.message.slice(0, 200) : "error");
    }
  }
  return result;
}
