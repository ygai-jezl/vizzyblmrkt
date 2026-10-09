import { renderPrompt } from "@/lib/agents/prompts/registry";
import { generateGroundedText, type GroundedSupport, type GroundedTextResult } from "@/lib/agents/gemini";
import { retrieveSemanticKnowledgeContext, type ContextRetrievalRequest } from "@/lib/agents/knowledgeRetrieval";
import { forTenant, listKnowledgePages, verifyOwner } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { assertSafeHttpsUrl, readTextCapped, safeFetch } from "@/lib/security/ssrf";
import { siteOf, sitesOf } from "@/lib/knowledge/site";
import { htmlToText } from "@/lib/content/create/siteText";
import {
  BlogEntityRelation,
  BlogIntent,
  CONTENT_PLAN_LIMITS,
  type BlogBrief,
  type BlogEntity,
  type BlogQuestion,
  type BlogSource,
  type ContentPlan,
} from "@/lib/types/contentPlan";
import { briefOf, hostOf, isCodeHostUrl, mergeResearch, normalizeUrl } from "./brief";
import { factFiguresOnPage } from "./figures";
import { blogResearchThinkingBudget } from "./flags";
import { chooseLinkTargets, pagesFromRepoPaths, type KnownPage } from "./links";

/**
 * Research for a blog hub — the up-front work that lets one article answer what buyers
 * actually ask and cite what it claims. Three searches side by side, then a merge:
 *
 *  1. QUESTIONS — a Google-Search-grounded call returns the buyer's primary question,
 *     the questions asked next and the entities to name.
 *  2. FACTS — a second grounded call finds third-party facts. A fact is only handed to
 *     the writer once its figures have been FOUND ON A PAGE we opened: the page search
 *     says backs it, or — search often answers without saying which page backs which
 *     sentence — the address the model gives for it. The model's address is only a
 *     lead: if the fact isn't on that page, the fact is dropped. A fact search DID tie
 *     to a page, but that we could not confirm there, stays in the brief marked
 *     unverified, for a person to check.
 *  3. LINK TARGETS — the brand's own pages, from what the programme has already indexed
 *     (a crawled site, or the page files of a connected repo, each checked to be live).
 *     Only a page on the brand's OWN SITE counts: a knowledge base can hold someone
 *     else's page too, and that is never offered as one of the brand's.
 *  4. The merge — a person's rows in the brief always stay; research replaces only its own.
 *
 * Fail-soft throughout: with Gemini off, a timeout or a blocked page, the article is
 * still written — from the brand's knowledge alone, with nothing invented to fill the gap.
 */

const MAX_FACTS = 8;
const MAX_FACTS_PER_PAGE = 2;
const MAX_PAGES_FETCHED = 12;
const MAX_ROUTES_CHECKED = 12;
/** Enough of a page to find a figure on it; a 512 MiB instance opens a few of these at once. */
const PAGE_BYTES = 800_000;
const UA = "Vizzybl-BlogResearch/1.0";
/** Google's redirect host for a grounded search result; the page itself is one hop behind it. */
const GROUNDING_HOST = "vertexaisearch.cloud.google.com";

export interface FetchedPage {
  /** The page's address after any redirects of its own. */
  url: string;
  title: string;
  siteName: string;
  /** The year the page says it was published; null when it does not say. */
  year: number | null;
  text: string;
}

export interface SitePages {
  /** Pages of the brand's site that were crawled. */
  pages: KnownPage[];
  /** File paths from connected repos — a route may be read off some of them. */
  repoPaths: string[];
}

export interface BlogResearchInput {
  ctx: TenantContext;
  workspace: { id: string; name: string; audience?: string | null };
  plan: ContentPlan;
  /** The tenant's brand name, when it has one. The programme's name stands in otherwise. */
  brandName?: string | null;
  /** How long the searches may take before research carries on with what it has. */
  timeoutMs?: number;
}

export interface BlogResearchDeps {
  grounded?: typeof generateGroundedText;
  retrieve?: typeof retrieveSemanticKnowledgeContext;
  sitePages?: (ctx: TenantContext, workspaceId: string) => Promise<SitePages>;
  /** Google's redirect link → the page's own address (null when it can't be followed). */
  resolve?: (uri: string) => Promise<string | null>;
  fetchPage?: (url: string) => Promise<FetchedPage | null>;
  /** Is this page live? Returns its address after redirects, or null. */
  reachable?: (url: string) => Promise<string | null>;
  now?: () => Date;
}

export interface BlogResearchResult {
  brief: BlogBrief;
  /** False when the question search returned nothing (off, timed out or failed). */
  searched: boolean;
  found: {
    questions: number;
    links: number;
    /** Facts search wrote down, before any was tied to a page. */
    facts: number;
    /** Facts kept: tied to the page search returned for them. */
    sources: number;
    /** Of those, the ones whose figures were found on the page. */
    verifiedSources: number;
  };
}

// ── Reading the model's lines ───────────────────────────────────────────────

/** A fact as search wrote it down, with the address the model gave for it ("" = none). */
export interface FoundFact {
  fact: string;
  url: string;
}

export interface ParsedResearch {
  primary: string;
  questions: BlogQuestion[];
  facts: FoundFact[];
  entities: BlogEntity[];
}

const clean = (s: string) => s.replace(/\s+/g, " ").replace(/^["“”']+|["“”']+$/g, "").trim();

/** A link to a search or a redirect, not to a page that could hold a fact. */
function isSearchLink(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.hostname === GROUNDING_HOST) return true;
    return /^(www\.)?(google|bing)\.[a-z.]+$/.test(u.hostname) && /^\/(search|url)\b/.test(u.pathname);
  } catch {
    return true;
  }
}

/** Parse the research answer (PRIMARY / Q / FACT / ENTITY lines). Unknown lines are skipped. */
export function parseResearch(text: string): ParsedResearch {
  const out: ParsedResearch = { primary: "", questions: [], facts: [], entities: [] };
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const m = /^\s*(?:[-*•]\s*)?\**(PRIMARY|Q|FACT|ENTITY)\**\s*:\**\s*(.+)$/i.exec(raw);
    if (!m) continue;
    const kind = (m[1] ?? "").toUpperCase();
    const parts = (m[2] ?? "").split(/\s+\|\s+/).map(clean);
    const head = parts[0] ?? "";
    if (!head) continue;
    if (kind === "PRIMARY") {
      out.primary ||= head.slice(0, 300);
    } else if (kind === "Q") {
      const intent = BlogIntent.safeParse((parts[1] ?? "").toLowerCase().replace(/[\s-]+/g, "_"));
      out.questions.push({ question: head.slice(0, 300), intent: intent.success ? intent.data : "other", by: "research" });
    } else if (kind === "FACT") {
      // The address is a lead to check, never evidence: keep it only if it could be a page.
      const url = normalizeUrl((parts[1] ?? "").replace(/^<|>$/g, ""));
      out.facts.push({ fact: head.slice(0, 600), url: url.startsWith("https://") && !isSearchLink(url) ? url : "" });
    } else {
      const relation = BlogEntityRelation.safeParse((parts[1] ?? "").toLowerCase().replace(/[\s-]+/g, "_"));
      if (relation.success) out.entities.push({ name: head.slice(0, 120), relation: relation.data, by: "research" });
    }
  }
  out.questions = out.questions.slice(0, CONTENT_PLAN_LIMITS.MAX_BLOG_QUESTIONS);
  out.facts = out.facts.slice(0, MAX_FACTS);
  out.entities = out.entities.slice(0, CONTENT_PLAN_LIMITS.MAX_BLOG_ENTITIES);
  return out;
}

/** Letters and digits only, of any script — so formatting never hides a match. */
const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * Which search results back this fact, by the API's own account: the supports whose
 * stretch of the answer holds the fact's sentence (or, failing a text match, overlaps
 * its byte range). Empty = search did not back it, so it is dropped.
 */
export function sourcesBacking(fact: string, answer: string, supports: GroundedSupport[]): number[] {
  const nf = squash(fact);
  if (nf.length < 12) return [];
  const head = nf.slice(0, 48);
  const tail = nf.slice(-48);
  let hits = supports.filter((s) => {
    const ns = squash(s.text);
    if (ns.length < 12) return false;
    return ns.includes(nf) || (ns.length >= 24 && nf.includes(ns)) || ns.includes(head) || ns.includes(tail);
  });
  if (hits.length === 0) {
    const at = answer.indexOf(fact);
    if (at >= 0) {
      const start = Buffer.byteLength(answer.slice(0, at), "utf8");
      const end = start + Buffer.byteLength(fact, "utf8");
      hits = supports.filter((s) => s.start !== null && s.end !== null && s.start < end && s.end > start);
    }
  }
  return [...new Set(hits.flatMap((s) => s.sourceIndexes))];
}

// ── Following a search result to its page ───────────────────────────────────

/** The page's own address behind Google's redirect link. One request to Google's host
 *  only; the page itself is not fetched here. */
export async function resolveGroundingRedirect(uri: string): Promise<string | null> {
  let u: URL;
  try {
    u = assertSafeHttpsUrl(uri);
  } catch {
    return null;
  }
  if (u.hostname !== GROUNDING_HOST) return u.toString(); // already the page's own address
  try {
    const res = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(5000) });
    const location = res.headers.get("location");
    await res.body?.cancel().catch(() => undefined);
    if (res.status < 300 || res.status >= 400 || !location) return null;
    return assertSafeHttpsUrl(new URL(location, u).toString()).toString();
  } catch {
    return null;
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)));
}

/** A <meta> tag's content, whichever order its attributes come in. The value runs to
 *  the quote that opened it (an apostrophe inside a double-quoted value is kept) and
 *  never past the end of its own tag. */
function metaContent(html: string, key: string): string {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m =
    new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${k}["'][^>]*\\scontent=(["'])((?:(?!\\1)[^<>])*)\\1`, "i").exec(html) ??
    new RegExp(`<meta[^>]+content=(["'])((?:(?!\\1)[^<>])*)\\1[^>]*\\s(?:property|name|itemprop)=["']${k}["']`, "i").exec(html);
  return m?.[2] ? decodeEntities(m[2]).replace(/\s+/g, " ").trim() : "";
}

/** A page's title, site name and published year, read from its own markup. */
export function readPageMeta(html: string, now = new Date()): Pick<FetchedPage, "title" | "siteName" | "year"> {
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  const title = (metaContent(html, "og:title") || decodeEntities(titleTag).replace(/\s+/g, " ").trim()).slice(0, 200);
  const dated =
    metaContent(html, "article:published_time") ||
    metaContent(html, "datePublished") ||
    /"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})/i.exec(html)?.[1] ||
    metaContent(html, "date") ||
    metaContent(html, "article:modified_time") ||
    "";
  const y = Number(/^(\d{4})\b/.exec(dated)?.[1]);
  const year = Number.isInteger(y) && y >= 1990 && y <= now.getUTCFullYear() + 1 ? y : null;
  return { title, siteName: metaContent(html, "og:site_name").slice(0, 120), year };
}

async function fetchSourcePage(url: string): Promise<FetchedPage | null> {
  try {
    const res = await safeFetch(
      url,
      { headers: { "User-Agent": UA, Accept: "text/html,text/plain" } },
      { timeoutMs: 7000, maxRedirects: 3 },
    );
    if (!res.ok || !/text\/html|text\/plain|application\/xhtml/i.test(res.headers.get("content-type") ?? "")) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    const html = await readTextCapped(res, PAGE_BYTES);
    return { url: res.url || url, ...readPageMeta(html), text: htmlToText(html) };
  } catch {
    return null;
  }
}

/** Is the page live? HEAD first; a server that refuses HEAD gets one small GET. */
async function pageReachable(url: string): Promise<string | null> {
  for (const method of ["HEAD", "GET"] as const) {
    try {
      const res = await safeFetch(url, { method, headers: { "User-Agent": UA } }, { timeoutMs: 4000, maxRedirects: 3 });
      await res.body?.cancel().catch(() => undefined);
      if (res.ok) return hostOf(res.url || url) === hostOf(url) ? res.url || url : null;
      if (method === "HEAD" && (res.status === 405 || res.status === 501 || res.status === 403)) continue;
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

/** What the programme has indexed: the pages of crawled sites, and the files of connected repos. */
async function indexedSitePages(ctx: TenantContext, workspaceId: string): Promise<SitePages> {
  const out: SitePages = { pages: [], repoPaths: [] };
  if (!(await verifyOwner(ctx, "workspace", workspaceId))) return out;
  const tickets = (
    await forTenant(ctx).ingestionTickets.find({
      where: [
        ["ownerKind", "==", "workspace"],
        ["ownerId", "==", workspaceId],
      ],
      limit: 200,
    })
  )
    .filter((t) => (t.status === "done" || t.status === "partial") && t.chunksWritten > 0)
    .sort((a, b) => (b.finishedAt ?? b.createdAt ?? "").localeCompare(a.finishedAt ?? a.createdAt ?? ""))
    .slice(0, 8);
  const lists = await Promise.all(
    tickets.map((t) =>
      listKnowledgePages(ctx, "workspace", workspaceId, { ticketId: t.id, limit: 600 })
        .then((pages) => ({ git: t.source === "github" || t.source === "gitlab", pages }))
        .catch(() => ({ git: false, pages: [] })),
    ),
  );
  for (const list of lists) {
    for (const p of list.pages) {
      if (list.git) {
        if (p.path) out.repoPaths.push(p.path);
      } else {
        out.pages.push({ url: p.sourceUri, title: p.title });
      }
    }
  }
  return out;
}

/** The site the brand's pages live on: where the article will be published, else the
 *  site most of the crawled pages are on. */
function siteOrigin(plan: ContentPlan, brief: BlogBrief, pages: KnownPage[]): string {
  for (const raw of [brief.publisherUrl, plan.strategy.hubUrl]) {
    try {
      if (raw && raw.startsWith("https://")) return new URL(raw).origin;
    } catch {
      /* not a URL */
    }
  }
  // Counted a site at a time (its sub-domains together), since this decides whose pages
  // are the brand's own; the address returned is the one most of that site's pages are on.
  const bySite = new Map<string, Map<string, number>>();
  for (const p of pages) {
    try {
      const u = new URL(p.url);
      if (u.protocol !== "https:" || isCodeHostUrl(p.url)) continue;
      const site = siteOf(p.url);
      const origins = bySite.get(site) ?? new Map<string, number>();
      origins.set(u.origin, (origins.get(u.origin) ?? 0) + 1);
      bySite.set(site, origins);
    } catch {
      /* skip */
    }
  }
  const total = (origins: Map<string, number>) => [...origins.values()].reduce((a, b) => a + b, 0);
  const most = [...bySite.values()].sort((a, b) => total(b) - total(a))[0];
  return most ? ([...most].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "") : "";
}

/** Run `fn` over `items`, a few at a time, keeping order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Tie each fact to a page and check the page says so. A fact's candidate pages are the
 * ones search says back it (its redirect links, followed), then the address the model
 * gave. Found on a page → verified. Not found, but search tied it to a page → unverified
 * (a person can check). Only the model's word for it, and not found there → dropped.
 */
async function sourcesFromFacts(
  facts: FoundFact[],
  grounded: GroundedTextResult,
  isOwn: (url: string) => boolean,
  deps: Required<Pick<BlogResearchDeps, "resolve" | "fetchPage">>,
): Promise<BlogSource[]> {
  const usable = (url: string) => url.startsWith("https://") && !isCodeHostUrl(url) && !isOwn(url);
  const backing = facts.map((f) => ({ ...f, indexes: sourcesBacking(f.fact, grounded.text, grounded.supports) }));
  const wanted = [...new Set(backing.flatMap((b) => b.indexes))];
  const resolved = new Map<number, string>();
  await mapLimit(wanted, 6, async (i) => {
    const url = await deps.resolve(grounded.sources[i]?.uri ?? "").catch(() => null);
    const n = url ? normalizeUrl(url) : "";
    if (usable(n)) resolved.set(i, n);
  });
  const candidatesOf = (b: (typeof backing)[number]) => {
    const tied = b.indexes.map((i) => resolved.get(i)).filter((u): u is string => Boolean(u));
    return { tied, all: [...new Set([...tied, ...(usable(b.url) ? [b.url] : [])])] };
  };
  const urls = [...new Set(backing.flatMap((b) => candidatesOf(b).all))].slice(0, MAX_PAGES_FETCHED);
  const pages = new Map<string, FetchedPage | null>();
  await mapLimit(urls, 4, async (url) => {
    pages.set(url, await deps.fetchPage(url).catch(() => null));
  });

  const out: BlogSource[] = [];
  const perPage = new Map<string, number>();
  for (const b of backing) {
    const { tied, all } = candidatesOf(b);
    const confirmed = all.find((u) => {
      const page = pages.get(u);
      // The year a page was published is on the page too, even when only its markup says so.
      return page ? factFiguresOnPage(b.fact, `${page.text}\n${page.year ?? ""}`) : false;
    });
    const url = confirmed ?? tied[0];
    if (!url) continue; // no page says it, and search tied it to none
    // One page should not be the article's only witness: at most two facts from each.
    const used = perPage.get(url) ?? 0;
    if (used >= MAX_FACTS_PER_PAGE) continue;
    perPage.set(url, used + 1);
    const page = pages.get(url) ?? null;
    out.push({
      url,
      title: page?.title ?? "",
      publisher: page?.siteName || hostOf(url),
      year: page?.year ?? null,
      fact: b.fact,
      status: confirmed ? "verified" : "unverified",
    });
  }
  return out;
}

/** Search for facts; if the call fails or comes back with none, once more while there is time. */
async function searchFacts(
  prompt: string,
  grounded: typeof generateGroundedText,
  deadline: number,
  clock: () => number,
): Promise<GroundedTextResult | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const left = deadline - clock();
    if (left < 10_000) break;
    const got = await grounded(prompt, { timeoutMs: left, thinkingBudget: blogResearchThinkingBudget() }).catch(() => null);
    if (got && parseResearch(got.text).facts.length) return got;
  }
  return null;
}

export async function researchBlogBrief(
  input: BlogResearchInput,
  deps: BlogResearchDeps = {},
): Promise<BlogResearchResult> {
  const { ctx, workspace, plan } = input;
  const clock = deps.now ?? (() => new Date());
  const now = clock();
  const deadline = now.getTime() + (input.timeoutMs ?? 60_000);
  const current = briefOf(plan);
  const brandName = current.publisherName.trim() || input.brandName?.trim() || workspace.name;
  const subject = [current.primaryQuestion, plan.scope.spark, plan.name].map((s) => s?.trim()).find(Boolean) ?? plan.name;

  // The brand's own knowledge on the subject: it keeps the questions on the product's
  // ground, and the pages it comes from are the ones that "go deeper" on this topic.
  const scopedTopic = plan.knowledge.groundingScope === "scoped" ? plan.scope.topics[0] : undefined;
  const req: ContextRetrievalRequest = {
    ctx,
    ownerKind: "workspace",
    ownerId: workspace.id,
    queryText: subject,
    limit: 12,
    bypassEnabledFlag: true,
    ...(scopedTopic ? { filter: { topic: scopedTopic } } : {}),
  };
  const rag = await (deps.retrieve ?? retrieveSemanticKnowledgeContext)(req).catch(() => null);
  const knowledgeContext = rag?.formatted ?? "";

  const today = now.toISOString().slice(0, 10);
  const audience = workspace.audience?.trim().slice(0, 500) || "(not given)";
  const search = deps.grounded ?? generateGroundedText;
  const questionsPrompt = renderPrompt("content.blog_research", {
    brand_name: brandName.slice(0, 120),
    today,
    spark: plan.scope.spark || plan.name,
    primary_question: current.primaryQuestion || "(not set — find it)",
    audience,
    buyer_questions: current.buyerQuestions.replace(/<\/?\s*buyer_questions[^>]*>/gi, " ") || "(none given)",
    knowledge_context: knowledgeContext || "(the brand has no indexed material yet)",
  });
  const factsPrompt = renderPrompt("content.blog_facts", {
    today,
    subject: (plan.scope.spark || plan.name).slice(0, 1000),
    primary_question: current.primaryQuestion || "(not set)",
    audience,
    brand_name: brandName.slice(0, 120),
  });

  const [asked, grounded, site] = await Promise.all([
    search(questionsPrompt, {
      timeoutMs: Math.max(deadline - clock().getTime(), 1_000),
      thinkingBudget: blogResearchThinkingBudget(),
    }).catch(() => null),
    searchFacts(factsPrompt, search, deadline, () => clock().getTime()),
    (deps.sitePages ?? indexedSitePages)(ctx, workspace.id).catch((): SitePages => ({ pages: [], repoPaths: [] })),
  ]);
  const parsed = parseResearch(asked?.text ?? "");
  const facts = parseResearch(grounded?.text ?? "").facts;

  // Link targets: crawled pages as they are; repo routes only once the live site answers.
  const origin = siteOrigin(plan, current, site.pages);
  // The brand's own site: where the article is published, and any site a person listed
  // a page of in the brief. A knowledge base can hold someone else's page as well (a
  // study, a competitor's pricing) — that is theirs, and is never offered as the brand's.
  const own = sitesOf([
    origin,
    current.publisherUrl,
    plan.strategy.hubUrl,
    ...current.links.filter((l) => l.by === "operator").map((l) => l.url),
  ]);
  const isOwn = (url: string) => own.has(siteOf(url));
  const guessed = origin ? pagesFromRepoPaths(site.repoPaths, origin, MAX_ROUTES_CHECKED) : [];
  const live = (
    await mapLimit(guessed, 6, async (p) => {
      const url = await (deps.reachable ?? pageReachable)(p.url).catch(() => null);
      return url ? { url, title: p.title } : null;
    })
  ).filter((p): p is KnownPage => p !== null);
  const related = (rag?.chunks ?? []).map((c) => c.sourceUri).filter((u) => u && !isCodeHostUrl(u));
  const links = chooseLinkTargets(
    [...site.pages, ...live].filter((p) => isOwn(p.url)),
    { related, exclude: [plan.strategy.hubUrl] },
  );
  const publisherUrl = origin || (links[0] ? new URL(links[0].url).origin : "");

  // Third-party facts — never from the brand's own site.
  const sources = grounded
    ? await sourcesFromFacts(facts, grounded, isOwn, {
        resolve: deps.resolve ?? resolveGroundingRedirect,
        fetchPage: deps.fetchPage ?? fetchSourcePage,
      })
    : [];

  // An integration is a factual claim about the product: keep one only if the brand's
  // own material names it.
  const firstParty = [knowledgeContext, ...(plan.knowledge.proofAssets ?? []), plan.scope.spark, current.buyerQuestions]
    .join("\n")
    .toLowerCase();
  const entities = parsed.entities.filter(
    (e) => e.relation !== "integration" || firstParty.includes(e.name.toLowerCase()),
  );

  const brief = mergeResearch(
    current,
    { primaryQuestion: parsed.primary, questions: parsed.questions, links, sources, entities, publisherName: brandName, publisherUrl },
    now.toISOString(),
  );
  return {
    brief,
    searched: Boolean(asked?.text),
    found: {
      questions: parsed.questions.length,
      links: links.length,
      facts: facts.length,
      sources: sources.length,
      verifiedSources: sources.filter((s) => s.status === "verified").length,
    },
  };
}
