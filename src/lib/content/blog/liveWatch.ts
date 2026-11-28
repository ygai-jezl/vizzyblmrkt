import { createHash } from "node:crypto";
import { checkVersions } from "./versionLive";
import { forTenant } from "@/lib/tenant";
import { listAllTenants } from "@/lib/tenant/registry";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { listRecentContentPlans, updateContentPlan } from "@/lib/tenant/workspaceContent";
import type { ContentNode, ContentPlan } from "@/lib/types/contentPlan";
import type { Tenant } from "@/lib/types/tenant";
import type { LiveWatchAddress, LiveWatchDoc } from "@/lib/types/liveWatch";
import { isBlogDatesEnabled, isBlogLiveWatchEnabled } from "@/lib/brandMap/flags";
import { nextDates } from "./dates";
import { readBrandMap } from "@/lib/brandMap/store";
import { autopilotHolds } from "@/lib/autopilot/planLock";
import { platformOrigin } from "@/lib/platform/origin";
import { siteOf } from "@/lib/knowledge/site";
import { htmlToText } from "@/lib/content/create/siteText";
import { fetchHtml, fetchSitemapFile, mayFetch, robotsFor, type FetchDeps, type Robots } from "@/lib/competitors/fetch";
import { asHttps, COMMON_SITEMAP_PATHS, onSite, pageKey, parseSitemap, type SitemapEntry } from "@/lib/competitors/sitemap";
import { robotsSitemaps } from "./crawlers";
import { articleAddressProblem } from "./address";
import { normalizeUrl } from "./brief";
import { outlineArticle } from "./outline";
import { fetchSourcePage, readH1, readPageDates, readPageMeta, readPostMeta } from "./research";
import { checkLive, nextLiveMark, pageDatesOf, pageMatches, type LiveCheck, type PageReader } from "./live";
import { writeLiveMark } from "./foundLive";
import { freshLiveWatchDoc, liveWatchDocId } from "./liveWatchWake";

export { wakeLiveWatch } from "./liveWatchWake";

/**
 * Found live, with nobody pressing anything (BLOG_LIVE_WATCH_ENABLED): a lane of the lifecycle tick.
 * Every 10 minutes it looks for brands that are due. A brand's pass, about every 3 hours while it
 * has articles waiting to go up:
 *  1. an article with an address saved is checked there (new addresses first), for two weeks;
 *  2. articles with no address are looked for on the brand's own sitemap: new or changed pages
 *     whose address shares the article's slug or words of its title are opened and matched on
 *     their text (most of the article on the page, nothing less);
 *  3. an article found live is approved, as a person's approval would (src/lib/content/blog/foundLive.ts).
 * It makes no AI calls: a sitemap read and a few page loads per brand per pass.
 */

export const LIVE_WATCH = {
  TICK_MS: 120_000,
  /** Ticks between looks for brands that are due (every 10 minutes). */
  SCAN_TICKS: 5,
  BRANDS_PER_TICK: 3,
  OPENS_PER_TICK: 4,
  OPENS_PER_BRAND: 6,
  PARALLEL: 3,
  /** Started only with this much of the lane's time left: one page can take 8 s. */
  MIN_LEFT_MS: 8_000,
  PASS_MS: 3 * 3_600_000,
  IDLE_MS: 6 * 3_600_000,
  /** A queued read carries on at the next look. */
  SOON_MS: 10 * 60_000,
  ADDRESS_DAYS: 14,
  WAITING_DAYS: 60,
  MAX_WORKSPACES: 20,
  PLANS_PER_WORKSPACE: 100,
  MAX_SEEN: 5_000,
  MAX_SITEMAPS: 5,
  MAX_SITEMAP_FILES: 10,
  SITEMAP_BYTES: 5 * 1024 * 1024,
  /** This share of entries on one lastmod day is a build date, not when each page changed. */
  BUILD_DATE_SHARE: 0.8,
} as const;

const DAY_MS = 86_400_000;
const docId = liveWatchDocId;
const seenId = (tenantId: string) => `lws_${tenantId}`;

/** The client name the brand's site sees (robots.txt groups name us "yougrowbot"). */
export function liveAgent(): string {
  const origin = platformOrigin();
  return `YouGrowBot/1.0 (live check${origin ? `; +${origin}` : ""})`;
}

export interface LiveWatchDeps {
  db?: FirestoreLike;
  clock?: () => number;
  listTenants?: () => Promise<Tenant[]>;
  /** Opens an address saved on an article (the canvas check's reader). */
  readAddress?: PageReader;
  /** Fetches for the sitemap and the pages found on it. */
  fetch?: FetchDeps["fetch"];
  /** The brand's own site, when the brand map and tenant aren't the source (tests). */
  siteOf?: (ctx: TenantContext, tenant: Tenant) => Promise<string | null>;
}

export interface LiveWatchResult {
  brands: number;
  opened: number;
  found: number;
  approved: number;
}

interface Budget {
  opens: number;
  deadlineMs: number;
  clock: () => number;
}

const left = (b: Budget) => b.deadlineMs - b.clock();
const canOpen = (b: Budget) => b.opens > 0 && left(b) >= LIVE_WATCH.MIN_LEFT_MS;

// ---- Articles waiting to go up --------------------------------------------------------------------

export interface WaitingArticle {
  plan: ContentPlan;
  workspaceId: string;
  hub: ContentNode;
  /** When it was written (its "Last updated" day, else when the plan was made), as epoch ms. */
  writtenMs: number;
  titles: string[];
  slug: string;
  /** Its address, when one is saved and usable. */
  url: string | null;
}

function writtenAt(plan: ContentPlan, hub: ContentNode): number {
  const day = Date.parse(hub.blog?.lastUpdated ?? "");
  return Number.isNaN(day) ? Date.parse(plan.createdAt) : day;
}

/** A live mark that counts: made at the article's saved address. */
function liveHere(plan: ContentPlan, hub: ContentNode): boolean {
  const live = hub.blog?.live;
  const url = plan.strategy.hubUrl?.trim();
  return Boolean(live && url && !articleAddressProblem(url) && normalizeUrl(live.url) === normalizeUrl(url));
}

/**
 * The brand's blog articles written in the last 60 days and not live yet (`waiting`). Never one
 * autopilot is writing. An article already marked live and not approved stays for a person: its
 * words may have changed since (a refresh), and only a new live check or a person approves them.
 */
export async function articlesToWatch(ctx: TenantContext, nowMs: number, deps: { db?: FirestoreLike } = {}): Promise<{ waiting: WaitingArticle[] }> {
  const workspaces = (await forTenant(ctx, deps.db).workspaces.find({ where: [], limit: 200 })).filter((w) => !w.archivedAt).slice(0, LIVE_WATCH.MAX_WORKSPACES);
  const waiting: WaitingArticle[] = [];
  for (const ws of workspaces) {
    const plans = await listRecentContentPlans(ctx, ws.id, LIVE_WATCH.PLANS_PER_WORKSPACE, deps.db).catch(() => [] as ContentPlan[]);
    for (const plan of plans) {
      if (plan.status === "archived" || plan.topology.hubChannel !== "blog" || plan.strategy.objective === "email_sequence" || autopilotHolds(plan)) continue;
      const hub = plan.graph.nodes.find((n) => n.type === "hub" && n.channel === "blog");
      if (!hub?.body.trim() || (hub.status !== "generated" && hub.status !== "approved")) continue;
      const writtenMs = writtenAt(plan, hub);
      if (nowMs - writtenMs > LIVE_WATCH.WAITING_DAYS * DAY_MS) continue;
      const address = plan.strategy.hubUrl?.trim() ?? "";
      const article: WaitingArticle = {
        plan,
        workspaceId: ws.id,
        hub,
        writtenMs,
        titles: [outlineArticle(hub.body).title ?? "", hub.blog?.metaTitle ?? "", plan.blog?.primaryQuestion ?? ""].filter((t) => t.trim()),
        slug: hub.blog?.slug?.trim().toLowerCase() ?? "",
        url: address && !articleAddressProblem(address) ? address : null,
      };
      if (!liveHere(plan, hub)) waiting.push(article);
    }
  }
  return { waiting };
}

// ---- Matching a sitemap's pages to articles --------------------------------------------------------

const STOP = new Set(
  "a an and are as at be by can do does for from get how i in is it its of on or our the their them they this to vs was what when where which who why will with you your blog post posts article articles news guide www com html htm php".split(
    " ",
  ),
);

/** The words worth matching on in a title or an address: three letters or more, not common ones. */
export function keyWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize("NFKC")
      .replace(/[‘’'"“”]/g, "")
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3 && !STOP.has(w)),
  );
}

/** The last part of an address's path, lower case ("/blog/how-to-x/" → "how-to-x"). */
function lastSegment(url: string): string {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    return decodeURIComponent(parts[parts.length - 1] ?? "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * How likely a page is to be this article, from its address alone: its slug (100), or how many key
 * words of the article's titles its path shares (two at least), or 0 (never opened).
 */
export function addressScore(url: string, article: Pick<WaitingArticle, "slug" | "titles">): number {
  if (article.slug && lastSegment(url) === article.slug) return 100;
  let path = "";
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    return 0;
  }
  const inPath = keyWords(path);
  const want = keyWords(article.titles.join(" "));
  let shared = 0;
  for (const w of want) if (inPath.has(w)) shared += 1;
  return shared >= 2 ? shared : 0;
}

/** A site that stamps one day on most pages (each deploy) gives no lastmod worth reading. */
export function withoutBuildDates(entries: SitemapEntry[]): SitemapEntry[] {
  const days = new Map<string, number>();
  for (const e of entries) if (e.lastmod) days.set(e.lastmod, (days.get(e.lastmod) ?? 0) + 1);
  const top = Math.max(0, ...days.values());
  if (entries.length < 10 || top / entries.length < LIVE_WATCH.BUILD_DATE_SHARE) return entries;
  return entries.map((e) => ({ ...e, lastmod: null }));
}

const hashOf = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 16);

// ---- The brand's own site ----------------------------------------------------------------------------

/** The brand's own site: its brand map's, else its root domain. */
async function brandSite(ctx: TenantContext, tenant: Tenant, deps: LiveWatchDeps): Promise<string | null> {
  if (deps.siteOf) return deps.siteOf(ctx, tenant);
  const read = await readBrandMap(ctx, deps.db).catch(() => null);
  const fromMap = read?.state === "ok" ? read.map.identity.site : "";
  const raw = fromMap || (tenant.rootDomain ? `https://${tenant.rootDomain.replace(/^https?:\/\//i, "")}` : "");
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? `https://${u.host}` : null;
  } catch {
    return null;
  }
}

interface SitemapRead {
  entries: SitemapEntry[];
  sitemaps: string[];
  queue: string[];
  robots: Robots | null;
  error: string | null;
}

/** Read the brand's sitemap files, newest first, as far as the time allows (the rest is queued). */
async function readSitemaps(site: string, doc: LiveWatchDoc, budget: Budget, fetchDeps: FetchDeps): Promise<SitemapRead> {
  const origin = new URL(site).origin;
  const key = siteOf(site);
  const robots = await robotsFor(origin, fetchDeps);
  if (!robots.reachable) return { entries: [], sitemaps: doc.sitemaps, queue: [], robots: null, error: robots.turnedAway ? "turned_away" : "unreachable" };
  let sitemaps = doc.site === site ? doc.sitemaps : [];
  if (!sitemaps.length) {
    sitemaps = robotsSitemaps(robots.text)
      .filter((u) => onSite(u, key))
      .map(asHttps)
      .slice(0, LIVE_WATCH.MAX_SITEMAPS);
  }
  const tryCommon = !sitemaps.length;
  const files = doc.site === site && doc.queue.length ? [...doc.queue] : tryCommon ? COMMON_SITEMAP_PATHS.map((p) => `${robots.origin}${p}`) : sitemaps.slice(0, 2);
  const entries: SitemapEntry[] = [];
  const found: string[] = [];
  let read = 0;
  while (files.length && read < LIVE_WATCH.MAX_SITEMAP_FILES) {
    if (left(budget) < LIVE_WATCH.MIN_LEFT_MS) break;
    const url = files.shift()!;
    if (!mayFetch(robots, url)) continue;
    const got = await fetchSitemapFile(url, fetchDeps);
    read += 1;
    if (!got.ok) continue;
    const parsed = parseSitemap(got.text);
    if (parsed.kind === "unknown") continue;
    if (tryCommon && !found.length) found.push(url);
    if (parsed.kind === "index") {
      const children = parsed.entries
        .filter((e) => onSite(e.loc, key))
        .sort((a, b) => (b.lastmod ?? "").localeCompare(a.lastmod ?? ""))
        .map((e) => asHttps(e.loc));
      for (const c of children) if (!files.includes(c) && files.length < LIVE_WATCH.MAX_SITEMAP_FILES) files.push(c);
      continue;
    }
    entries.push(...parsed.entries);
  }
  const known = tryCommon ? found : sitemaps;
  const error = !known.length && !entries.length ? "no_sitemap" : null;
  return { entries, sitemaps: known, queue: files.slice(0, LIVE_WATCH.MAX_SITEMAP_FILES), robots, error };
}

interface OpenedPage {
  url: string;
  title: string;
  h1: string;
  text: string;
  publishedAt: string | null;
  /** The dates the page gives itself, as written. */
  dates: { published: string | null; modified: string | null };
}

/** Open a page found on the sitemap, as the brand's robots.txt allows. */
async function openPage(url: string, robots: Robots, fetchDeps: FetchDeps): Promise<OpenedPage | null> {
  if (!mayFetch(robots, url)) return null;
  const got = await fetchHtml(url, fetchDeps);
  if (!got.ok) return null;
  const html = got.text;
  return {
    url: got.url || url,
    title: readPageMeta(html).title,
    h1: readH1(html),
    text: htmlToText(html),
    publishedAt: readPostMeta(html).publishedAt,
    dates: readPageDates(html),
  };
}

/** Run `work` over `items`, `limit` at a time. */
async function inBatches<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) out.push(...(await Promise.all(items.slice(i, i + limit).map(work))));
  return out;
}

// ---- A brand's pass --------------------------------------------------------------------------------

const freshDoc = freshLiveWatchDoc;

interface PassResult {
  opened: number;
  found: number;
  approved: number;
}

/** Mark an article live where it was found, and approve it. */
async function markFound(ctx: TenantContext, article: WaitingArticle, url: string, check: LiveCheck, found: "address" | "sitemap", at: string, deps: LiveWatchDeps): Promise<boolean> {
  const written = await writeLiveMark(
    ctx,
    {
      workspaceId: article.workspaceId,
      plan: article.plan,
      nodeId: article.hub.id,
      mark: (stored) => nextLiveMark(stored, { url, at, by: "check", check, found, auto: true }),
      approve: true,
      // Found live sets the day it went up: the page's own date, else when it was first seen.
      ...(isBlogDatesEnabled()
        ? { dates: (stored, live) => (live ? nextDates(stored, { page: pageDatesOf(check), liveAt: live.at, now: new Date(at) }) : undefined) }
        : {}),
    },
    { db: deps.db },
  );
  return Boolean(written?.approved);
}

async function passBrand(ctx: TenantContext, tenant: Tenant, budget: Budget, deps: LiveWatchDeps): Promise<PassResult> {
  const result: PassResult = { opened: 0, found: 0, approved: 0 };
  const nowMs = budget.clock();
  const at = new Date(nowMs).toISOString();
  const repo = forTenant(ctx, deps.db).liveWatch;
  const doc: LiveWatchDoc = { ...freshDoc(ctx.tenantId, at), ...((await repo.getById(docId(ctx.tenantId))) ?? {}) };
  const { waiting } = await articlesToWatch(ctx, nowMs, { db: deps.db });

  // 1. Addresses saved on articles: a new one straight away, then every few hours, for two weeks.
  const withAddress = waiting.filter((a) => a.url);
  const addresses: Record<string, LiveWatchAddress> = {};
  for (const a of withAddress) {
    const kept = doc.addresses[a.plan.id];
    addresses[a.plan.id] = kept && normalizeUrl(kept.url) === normalizeUrl(a.url!) ? kept : { url: a.url!, firstAt: at, nextAt: at, checks: 0, textShare: null };
  }
  const due = withAddress.filter((a) => {
    const s = addresses[a.plan.id]!;
    return Date.parse(s.nextAt) <= nowMs && nowMs - Date.parse(s.firstAt) <= LIVE_WATCH.ADDRESS_DAYS * DAY_MS;
  });
  for (const a of due) {
    if (!canOpen(budget)) break;
    budget.opens -= 1;
    result.opened += 1;
    const check = await checkLive(a.url!, a.titles, deps.readAddress ?? fetchSourcePage, { body: a.hub.body });
    const s = addresses[a.plan.id]!;
    if (check.matched) {
      result.found += 1;
      if (await markFound(ctx, a, a.url!, check, "address", at, deps)) result.approved += 1;
      delete addresses[a.plan.id];
      continue;
    }
    addresses[a.plan.id] = { ...s, nextAt: new Date(nowMs + LIVE_WATCH.PASS_MS).toISOString(), checks: s.checks + 1, textShare: check.textShare ?? null };
  }

  // 1b. Articles' versions in other languages, at their own addresses (PAGE_LANGUAGES_ENABLED).
  const versions = await checkVersions(ctx, { canOpen: () => canOpen(budget), open: () => void (budget.opens -= 1) }, { db: deps.db, read: deps.readAddress ?? fetchSourcePage, nowMs });
  result.opened += versions.opened;
  result.found += versions.found;
  result.approved += versions.approved;

  // 2. The sitemap, for articles with no address.
  const noAddress = waiting.filter((a) => !a.url);
  let sitemapNextAt = doc.sitemapNextAt;
  let { site, sitemaps, queue, lastError } = doc;
  let more = false;
  let unfound = noAddress.length;
  if (noAddress.length && (!sitemapNextAt || Date.parse(sitemapNextAt) <= nowMs) && canOpen(budget)) {
    const found = await sitemapPass(ctx, tenant, doc, noAddress, waiting, budget, at, deps);
    result.opened += found.opened;
    result.found += found.found;
    result.approved += found.approved;
    ({ site, sitemaps, queue, lastError } = found.state);
    more = found.more;
    unfound = found.unfound;
    sitemapNextAt = new Date(nowMs + (more ? 0 : LIVE_WATCH.PASS_MS)).toISOString();
  }

  // 3. When to come back.
  const stillWaiting = Object.values(addresses).filter((s) => nowMs - Date.parse(s.firstAt) <= LIVE_WATCH.ADDRESS_DAYS * DAY_MS);
  const soonest = Math.min(
    ...stillWaiting.map((s) => Date.parse(s.nextAt)),
    unfound && sitemapNextAt ? Date.parse(sitemapNextAt) : Infinity,
    versions.waiting ? nowMs + LIVE_WATCH.PASS_MS : Infinity,
  );
  const nextMs = more ? nowMs + LIVE_WATCH.SOON_MS : Number.isFinite(soonest) ? Math.max(nowMs + LIVE_WATCH.PASS_MS, soonest) : nowMs + LIVE_WATCH.IDLE_MS;
  const next: LiveWatchDoc = { ...doc, nextAt: new Date(nextMs).toISOString(), sitemapNextAt, site, sitemaps, queue, addresses, lastError, updatedAt: at };
  const { id: _id, tenantId: _t, ...fields } = next;
  await repo.upsert(docId(ctx.tenantId), () => fields, () => fields);
  return result;
}

async function sitemapPass(
  ctx: TenantContext,
  tenant: Tenant,
  doc: LiveWatchDoc,
  noAddress: WaitingArticle[],
  waiting: WaitingArticle[],
  budget: Budget,
  at: string,
  deps: LiveWatchDeps,
): Promise<PassResult & { more: boolean; unfound: number; state: Pick<LiveWatchDoc, "site" | "sitemaps" | "queue" | "lastError"> }> {
  const out = { opened: 0, found: 0, approved: 0, more: false, unfound: noAddress.length };
  const site = await brandSite(ctx, tenant, deps);
  if (!site) return { ...out, state: { site: "", sitemaps: [], queue: [], lastError: "no_site" } };
  const fetchDeps: FetchDeps = { agent: liveAgent(), maxSitemapBytes: LIVE_WATCH.SITEMAP_BYTES, ...(deps.fetch ? { fetch: deps.fetch } : {}) };
  const read = await readSitemaps(site, doc, budget, fetchDeps);
  const state = { site, sitemaps: read.sitemaps, queue: read.queue, lastError: read.error };
  if (!read.robots || !read.entries.length) return { ...out, more: read.queue.length > 0, state };

  const seenRepo = forTenant(ctx, deps.db).liveWatchSeen;
  const seenLines = (await seenRepo.getById(seenId(ctx.tenantId)))?.lines ?? [];
  const seen = new Map(seenLines.map((l) => [l.split("\t")[0]!, l.split("\t")[1] ?? ""] as const));
  const key = siteOf(site);
  // Addresses already taken: another article's live address, and links or sources an article points to.
  const taken = new Set<string>();
  for (const a of waiting) {
    if (a.hub.blog?.live?.url) taken.add(normalizeUrl(a.hub.blog.live.url));
    for (const l of a.plan.blog?.links ?? []) taken.add(normalizeUrl(l.url));
    for (const s of a.plan.blog?.sources ?? []) taken.add(normalizeUrl(s.url));
  }
  const oldestDay = new Date(Math.min(...noAddress.map((a) => a.writtenMs))).toISOString().slice(0, 10);
  const candidates: Array<{ url: string; hash: string; lastmod: string; score: number }> = [];
  for (const e of withoutBuildDates(read.entries)) {
    const url = asHttps(e.loc);
    if (!onSite(url, key) || taken.has(normalizeUrl(url))) continue;
    const pk = pageKey(url, site, key);
    if (!pk) continue;
    const hash = hashOf(pk);
    if (seen.has(hash) && seen.get(hash) === (e.lastmod ?? "")) continue;
    if (e.lastmod && e.lastmod < oldestDay) continue;
    const score = Math.max(...noAddress.map((a) => addressScore(url, a)));
    if (score > 0) candidates.push({ url, hash, lastmod: e.lastmod ?? "", score });
  }
  candidates.sort((a, b) => b.score - a.score);
  const take = Math.min(LIVE_WATCH.OPENS_PER_BRAND, budget.opens);
  const batch = candidates.slice(0, take);
  out.more = candidates.length > take || read.queue.length > 0;
  budget.opens -= batch.length;
  out.opened = batch.length;

  const open = noAddress.slice();
  const pages = await inBatches(batch, LIVE_WATCH.PARALLEL, async (c) => ({ c, page: left(budget) >= LIVE_WATCH.MIN_LEFT_MS ? await openPage(c.url, read.robots!, fetchDeps) : null }));
  for (const { c, page } of pages) {
    seen.delete(c.hash);
    seen.set(c.hash, c.lastmod);
    if (!page) continue;
    let best: { article: WaitingArticle; check: LiveCheck } | null = null;
    for (const article of open) {
      // A page dated well before the article was written is an older page, not this article.
      if (page.publishedAt && Date.parse(page.publishedAt) < article.writtenMs - DAY_MS) continue;
      const m = pageMatches(page, { titles: article.titles, body: article.hub.body }, { strict: true });
      if (!m.matched || (best && (best.check.textShare ?? 0) >= m.textShare)) continue;
      best = { article, check: { reachable: true, refused: false, title: page.title, matched: true, heading: m.heading, textShare: m.textShare, pageDates: page.dates } };
    }
    if (!best) continue;
    open.splice(open.indexOf(best.article), 1);
    out.found += 1;
    await updateContentPlan(ctx, best.article.workspaceId, best.article.plan.id, { hubUrl: page.url }, deps.db);
    const plan = { ...best.article.plan, strategy: { ...best.article.plan.strategy, hubUrl: page.url } };
    if (await markFound(ctx, { ...best.article, plan, url: page.url }, page.url, best.check, "sitemap", at, deps)) out.approved += 1;
  }

  out.unfound = open.length;
  if (!open.length) out.more = false;
  const lines = [...seen.entries()].map(([h, d]) => `${h}\t${d}`).slice(-LIVE_WATCH.MAX_SEEN);
  await seenRepo.upsert(seenId(ctx.tenantId), () => ({ lines, updatedAt: at }), () => ({ lines, updatedAt: at }));
  return { ...out, state };
}

// ---- The lane ------------------------------------------------------------------------------------------

/** A tick that looks for brands that are due (every 10 minutes). */
export const isScanTick = (nowMs: number) => Math.floor(nowMs / LIVE_WATCH.TICK_MS) % LIVE_WATCH.SCAN_TICKS === 0;

export async function runLiveWatch(opts: { deadlineMs: number }, deps: LiveWatchDeps = {}): Promise<LiveWatchResult> {
  const result: LiveWatchResult = { brands: 0, opened: 0, found: 0, approved: 0 };
  if (!isBlogLiveWatchEnabled()) return result;
  const clock = deps.clock ?? Date.now;
  if (!isScanTick(clock())) return result;
  const tenants = await (deps.listTenants ?? listAllTenants)();
  const offset = tenants.length ? Math.floor(clock() / LIVE_WATCH.TICK_MS) % tenants.length : 0;
  const order = [...tenants.slice(offset), ...tenants.slice(0, offset)];
  const budget: Budget = { opens: LIVE_WATCH.OPENS_PER_TICK, deadlineMs: opts.deadlineMs, clock };
  for (const t of order) {
    if (result.brands >= LIVE_WATCH.BRANDS_PER_TICK || left(budget) < LIVE_WATCH.MIN_LEFT_MS) break;
    if (t.status === "suspended") continue;
    const ctx: TenantContext = { tenantId: t.id, region: t.region, source: "system" };
    try {
      const doc = await forTenant(ctx, deps.db).liveWatch.getById(docId(t.id));
      if (doc && Date.parse(doc.nextAt) > clock()) continue;
      result.brands += 1;
      const r = await passBrand(ctx, t, budget, deps);
      result.opened += r.opened;
      result.found += r.found;
      result.approved += r.approved;
    } catch (err) {
      console.warn(`[live-watch] ${t.id} failed:`, err instanceof Error ? err.message.slice(0, 200) : "error");
    }
  }
  return result;
}
