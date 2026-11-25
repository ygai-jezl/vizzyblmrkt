import { createHash, randomUUID } from "node:crypto";
import { retrieveSemanticKnowledgeContext } from "@/lib/agents/knowledgeRetrieval";
import type { AiUsage, generateTextWithDeadline } from "@/lib/agents/gemini";
import { isBlogRefreshEnabled, isBrandMapScaleEnabled } from "@/lib/brandMap/flags";
import { listBrandMapPages } from "@/lib/brandMap/pages";
import { subjectCoverage } from "@/lib/brandMap/recount";
import { readBrandMap } from "@/lib/brandMap/store";
import { readLiveFor } from "@/lib/connectors/service";
import { searchConsoleManifest } from "@/lib/connectors/manifests/searchConsole";
import { planningConnections } from "@/lib/connectors/signals/review";
import { aiUsage } from "@/lib/plans/meter";
import { forTenant } from "@/lib/tenant";
import { listAllTenants } from "@/lib/tenant/registry";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { getContentPlan } from "@/lib/tenant/workspaceContent";
import type { ArticleReviewDoc, ReviewBy, ReviewEvidence, ReviewStep } from "@/lib/types/articleRefresh";
import { REVIEW_STEPS } from "@/lib/types/articleRefresh";
import type { BrandMapPage } from "@/lib/types/brandMapPage";
import type { ContentNode, ContentPlan } from "@/lib/types/contentPlan";
import { askOfPlan, loadArticleMap } from "./mapActions";
import { computeCoverage } from "./coverage";
import { articleFigures, factFiguresOnPage, wordsOf } from "./figures";
import { accountCovers, bareHost } from "./freshnessPages";
import { checkLinkState, outboundLinks, type LinkState } from "./freshnessWatch";
import { isSeenOn, tenantBrand } from "./hubActions";
import { outlineArticle } from "./outline";
import { fetchSourcePage, researchBlogBrief, type FetchedPage } from "./research";
import { matchSeen } from "./seen";
import { recordDecision, recordProposals, recordStart } from "./refreshRecords";
import { reviewId } from "./refreshHold";

/**
 * A refresh review of a live blog article (BLOG_REFRESH_ENABLED): five short stored steps, moved
 * on by the open article, Vizzy or the lifecycle tick, like the autopilot's runs. Each step reads
 * what it needs afresh and is safe to run again, so one cut short just runs again.
 *
 *   read      the copy: its sections, figures and links (no AI)
 *   sources   every cited page opened again: gone, moved, or no longer showing its figure (no AI)
 *   research  a fresh brief on the subject, compared with the copy; never saved over the brief
 *   brand     open questions on its subject, product facts, notes, and the searches that land here
 *   propose   one model call, checked by code (src/lib/content/blog/refreshPropose.ts)
 *
 * The review only reads until a person applies what it proposes; Regenerate and Research wait
 * while one runs (`reviewHolds`), since they replace the copy whole. One doc per article,
 * `ar_<planId>`, holds the current or last review. /help/write-and-schedule#refresh explains it.
 */

export { reviewHolds, reviewId, REVIEW_RUNNING } from "./refreshHold";

export const REVIEW = {
  /** A step's lease: long enough for the slowest step, short enough to pick up a stalled one. */
  LEASE_MS: 3 * 60_000,
  MAX_ATTEMPTS: 3,
  RETRY_MS: 2 * 60_000,
  /** The longest each step takes, so one starts only with time for it. */
  STEP_MS: { read: 8_000, sources: 30_000, research: 70_000, brand: 40_000, propose: 50_000 } satisfies Record<ReviewStep, number>,
  /** Research's own limit, inside its step's. */
  RESEARCH_MS: 55_000,
  MAX_EVIDENCE: 40,
  MAX_LINKS: 12,
  MAX_SOURCES: 8,
  MAX_NEW_FACTS: 6,
  MAX_QUESTIONS: 5,
  MAX_SEARCHES: 5,
  /** A search that lands on the page counts with at least this many impressions in 28 days. */
  MIN_IMPRESSIONS: 20,
  /** Reviews moved per tick, across brands. */
  PER_TICK: 2,
} as const;

/** Said when a review can't read something; each said once. */
export const REVIEW_NOTES = {
  searchLimited: "This month's web searches for research are used up, so no newer research was read.",
  noSearchConsole: "Search Console isn't connected for this site, or isn't shared with the team and Vizzy, so the searches that land on this page weren't read.",
  searchConsoleFailed: "Search Console didn't answer, so the searches that land on this page weren't read.",
} as const;

export interface ReviewDeps {
  db?: FirestoreLike;
  now?: () => Date;
  /** The usage (tests); otherwise the brand's own, as blog_refresh. */
  usage?: AiUsage;
  checkLink?: (url: string) => Promise<LinkState>;
  fetchPage?: (url: string) => Promise<FetchedPage | null>;
  research?: typeof researchBlogBrief;
  /** The brand's name and own sites (tests); otherwise from its record. */
  brand?: (ctx: TenantContext) => Promise<{ name: string | null; sites: string[] }>;
  retrieve?: typeof retrieveSemanticKnowledgeContext;
  seen?: typeof matchSeen;
  openQuestions?: (ctx: TenantContext, subjectId: string) => Promise<string[]>;
  pageSearches?: (ctx: TenantContext, liveUrl: string) => Promise<PageSearches>;
  /** The propose step's model call (tests). */
  generate?: typeof generateTextWithDeadline;
  /** Steps in place of the built-in ones (tests). */
  steps?: Partial<Record<ReviewStep, StepFn>>;
  listTenants?: typeof listAllTenants;
}

export interface PageSearches {
  rows: Array<{ query: string; impressions: number; clicks: number; position: number | null }>;
  note: string | null;
}

/** What a step changes on the review. Evidence and notes are added to what is there. */
export interface StepResult {
  evidence?: Omit<ReviewEvidence, "id">[];
  notes?: string[];
  reading?: ArticleReviewDoc["reading"];
  proposals?: ArticleReviewDoc["proposals"];
  /** Ends the review here: ready (proposals) or nothing (no change worth making). */
  finish?: "ready" | "nothing";
  error?: string;
}

export interface StepInput {
  review: ArticleReviewDoc;
  plan: ContentPlan;
  node: ContentNode;
  usage: AiUsage;
  deadlineMs: number;
}

export type StepFn = (ctx: TenantContext, input: StepInput, deps: ReviewDeps) => Promise<StepResult>;

const nowOf = (deps: ReviewDeps) => (deps.now ?? (() => new Date()))();
const monthOf = (d: Date) => d.toISOString().slice(0, 7);
const repoOf = (ctx: TenantContext, deps: ReviewDeps) => forTenant(ctx, deps.db).articleReviews;
const hubOf = (plan: ContentPlan, nodeId?: string) =>
  plan.graph.nodes.find((n) => (nodeId ? n.id === nodeId : true) && n.type === "hub" && n.channel === "blog");
export const bodyHash = (body: string) => createHash("sha256").update(body).digest("hex").slice(0, 16);

/** The usage a step's model calls and searches count against, adding to what the review spent. */
export function talliedUsage(usage: AiUsage, spent: { searches: number; tokens: number }): AiUsage {
  return {
    check: (kind, units) => usage.check(kind, units),
    recordModel: async (tokens, model, o) => {
      if (!o?.lost) spent.tokens += Math.max(0, Math.round(tokens));
      return usage.recordModel(tokens, model, o);
    },
    recordSearches: async (n, o) => {
      if (!o?.lost) spent.searches += Math.max(0, Math.round(n));
      return usage.recordSearches(n, o);
    },
    recordImages: (n) => usage.recordImages(n),
  };
}

export async function readReview(ctx: TenantContext, planId: string, deps: ReviewDeps = {}): Promise<ArticleReviewDoc | null> {
  return repoOf(ctx, deps).getById(reviewId(planId)).catch(() => null);
}

export type StartResult = { ok: true; review: ArticleReviewDoc; started: boolean } | { ok: false; status: number; error: string };

/**
 * Start a review of a live article, or hand back the one already running. A person, the autopilot
 * or Vizzy starts it; the caller has checked who may (and the brand's grant and cap).
 */
export async function startReview(
  ctx: TenantContext,
  args: { plan: ContentPlan; nodeId?: string; by: ReviewBy },
  deps: ReviewDeps = {},
): Promise<StartResult> {
  if (!isBlogRefreshEnabled()) return { ok: false, status: 503, error: "unavailable" };
  const { plan, by } = args;
  const node = hubOf(plan, args.nodeId);
  if (!node) return { ok: false, status: 404, error: "not_a_blog_article" };
  if (!node.blog?.live) return { ok: false, status: 409, error: "not_live" };
  if (!node.body.trim()) return { ok: false, status: 409, error: "nothing_to_review" };
  const now = nowOf(deps);
  const at = now.toISOString();
  const f = node.blog.freshness;
  const why: ArticleReviewDoc["why"] = {
    state: f?.state ?? null,
    clockDays: f?.clockDays ?? null,
    arm: f?.arm ?? null,
    reasons: (f?.reasons ?? []).map((r) => r.detail).slice(0, 8),
    dueAt: f?.dueAt ?? null,
    waitedDays: f && f.state === "due" ? Math.max(0, Math.floor((now.getTime() - Date.parse(f.dueAt)) / 86_400_000)) : null,
  };
  const fresh = (dismissed: string[]): Omit<ArticleReviewDoc, "id" | "tenantId"> => ({
    planId: plan.id,
    workspaceId: plan.workspaceId,
    nodeId: node.id,
    reviewId: `rv_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
    by,
    byUid: by === "autopilot" ? null : (ctx.userId ?? null),
    step: REVIEW_STEPS[0],
    state: "running",
    active: true,
    nextAt: at,
    leaseId: null,
    leaseUntil: null,
    attempts: 0,
    startedAt: at,
    finishedAt: null,
    updatedAt: at,
    month: monthOf(now),
    why,
    reading: null,
    evidence: [],
    notes: [],
    proposals: [],
    dismissed,
    spent: { searches: 0, tokens: 0 },
    error: null,
  });
  let started = true;
  const { doc } = await repoOf(ctx, deps).upsert(
    reviewId(plan.id),
    () => fresh([]),
    (cur) => {
      // One review at a time: a running one is handed back as it is.
      if (cur.active) {
        started = false;
        return null;
      }
      return fresh(cur.dismissed ?? []);
    },
  );
  if (started) await recordStart(ctx, doc, deps);
  return { ok: true, review: doc, started };
}

/** Stop a running review (a person, or the article stopped being live). Proposals already made stay. */
export async function stopReview(ctx: TenantContext, planId: string, deps: ReviewDeps = {}): Promise<ArticleReviewDoc | null> {
  const at = nowOf(deps).toISOString();
  const stopped = await repoOf(ctx, deps).claim(reviewId(planId), (cur) =>
    cur.active ? { active: false, step: null, state: "stopped", leaseId: null, leaseUntil: null, finishedAt: at, updatedAt: at } : null,
  );
  if (stopped) await recordDecision(ctx, stopped, { outcome: "stopped", accepted: 0, real: false, byUid: ctx.userId ?? null }, deps);
  return stopped;
}

async function claimStep(ctx: TenantContext, planId: string, deps: ReviewDeps): Promise<(ArticleReviewDoc & { leaseId: string }) | null> {
  const now = nowOf(deps).getTime();
  const leaseId = randomUUID();
  const got = await repoOf(ctx, deps).claim(reviewId(planId), (cur) => {
    const free = cur.active && cur.step !== null && Date.parse(cur.nextAt) <= now && (!cur.leaseUntil || Date.parse(cur.leaseUntil) <= now);
    return free ? { leaseId, leaseUntil: new Date(now + REVIEW.LEASE_MS).toISOString(), attempts: cur.attempts + 1 } : null;
  });
  return got ? { ...got, leaseId } : null;
}

const STEPS: Record<Exclude<ReviewStep, "propose">, StepFn> = {
  read: async (_ctx, { node, plan }) => readStep(node, plan),
  sources: (ctx, input, deps) => sourcesStep(ctx, input, deps),
  research: (ctx, input, deps) => researchStep(ctx, input, deps),
  brand: (ctx, input, deps) => brandStep(ctx, input, deps),
};

/**
 * Take and do the review's next step. Null when it isn't due, another holds it, or it has
 * finished; otherwise the review after the step.
 */
export async function advanceReview(ctx: TenantContext, planId: string, opts: { deadlineMs: number }, deps: ReviewDeps = {}): Promise<ArticleReviewDoc | null> {
  if (!isBlogRefreshEnabled()) return null;
  const review = await claimStep(ctx, planId, deps);
  if (!review || !review.step) return null;
  const step = review.step;
  const plan = await getContentPlan(ctx, review.workspaceId, planId, deps.db).catch(() => null);
  const node = plan ? hubOf(plan, review.nodeId) : undefined;
  const spent = { searches: 0, tokens: 0 };
  let result: StepResult;
  if (!plan || !node || !node.blog?.live) {
    result = { error: "article_gone" };
  } else {
    // Propose lives with Apply (refreshPropose.ts), loaded only when a review gets that far.
    const fn = (deps.steps ?? {})[step] ?? (step === "propose" ? (await import("./refreshPropose")).proposeStep : STEPS[step]);
    const usage = talliedUsage(deps.usage ?? aiUsage(ctx, "blog_refresh", { db: deps.db }), spent);
    try {
      result = fn ? await fn(ctx, { review, plan, node, usage, deadlineMs: opts.deadlineMs }, deps) : { error: `no_step_${step}` };
    } catch (err) {
      console.warn(`[refresh] ${review.reviewId} ${step} failed:`, err instanceof Error ? err.message.slice(0, 200) : "error");
      result = { error: "step_failed" };
    }
  }
  const after = await finishStep(ctx, review, step, result, spent, deps);
  // Finished: what it proposed, and (for nothing or a failure) the decision, on its record.
  if (after && !after.active && after.reviewId === review.reviewId) {
    if (after.state === "ready" || after.state === "nothing") await recordProposals(ctx, after, deps);
    if (after.state === "nothing" || after.state === "failed") await recordDecision(ctx, after, { outcome: after.state, accepted: 0, real: false, byUid: null }, deps);
  }
  return after;
}

async function finishStep(
  ctx: TenantContext,
  review: ArticleReviewDoc & { leaseId: string },
  step: ReviewStep,
  result: StepResult,
  spent: { searches: number; tokens: number },
  deps: ReviewDeps,
): Promise<ArticleReviewDoc | null> {
  const now = nowOf(deps);
  const at = now.toISOString();
  return repoOf(ctx, deps).claim(reviewId(review.planId), (cur) => {
    if (cur.leaseId !== review.leaseId || cur.step !== step || cur.reviewId !== review.reviewId) return null;
    const total = { searches: cur.spent.searches + spent.searches, tokens: cur.spent.tokens + spent.tokens };
    const base = { leaseId: null, leaseUntil: null, updatedAt: at, spent: total };
    if (result.error) {
      const gone = result.error === "article_gone";
      if (gone || cur.attempts >= REVIEW.MAX_ATTEMPTS) {
        return { ...base, active: false, step: null, state: "failed" as const, error: result.error.slice(0, 80), finishedAt: at };
      }
      return { ...base, error: result.error.slice(0, 80), nextAt: new Date(now.getTime() + REVIEW.RETRY_MS).toISOString() };
    }
    const added = (result.evidence ?? []).slice(0, Math.max(0, REVIEW.MAX_EVIDENCE - cur.evidence.length));
    const evidence = [...cur.evidence, ...added.map((e, i) => ({ ...e, id: `e${cur.evidence.length + i + 1}` }))];
    const notes = [...new Set([...cur.notes, ...(result.notes ?? [])])].slice(0, 8);
    const next = REVIEW_STEPS[REVIEW_STEPS.indexOf(step) + 1] ?? null;
    const finished = result.finish ?? (next ? null : "nothing");
    return {
      ...base,
      evidence,
      notes,
      ...(result.reading !== undefined ? { reading: result.reading } : {}),
      ...(result.proposals !== undefined ? { proposals: result.proposals } : {}),
      error: null,
      attempts: 0,
      ...(finished ? { active: false, step: null, state: finished, finishedAt: at } : { step: next, nextAt: at }),
    };
  });
}

// ---- Step 1: read ----------------------------------------------------------------------------

function readStep(node: ContentNode, plan: ContentPlan): StepResult {
  const outline = outlineArticle(node.body);
  const liveUrl = node.blog?.live?.url ?? plan.strategy.hubUrl ?? "";
  let host = "";
  try {
    host = new URL(liveUrl).hostname;
  } catch {
    // No address: every https link counts as outbound.
  }
  return {
    reading: {
      bodyHash: bodyHash(node.body),
      headings: [...outline.sections.map((s) => s.heading), ...outline.faq.map((f) => f.question)].slice(0, 40),
      figures: [...new Set(articleFigures(node.body).map((f) => f.core))].slice(0, 80),
      links: outboundLinks(node.body, host).slice(0, REVIEW.MAX_LINKS),
      liveUrl,
    },
  };
}

// ---- Step 2: sources -------------------------------------------------------------------------

async function sourcesStep(_ctx: TenantContext, { review, plan }: StepInput, deps: ReviewDeps): Promise<StepResult> {
  const links = review.reading?.links ?? [];
  const sources = (plan.blog?.sources ?? []).filter((s) => s.status !== "unverified" && s.fact && articleFigures(s.fact).length).slice(0, REVIEW.MAX_SOURCES);
  const check = deps.checkLink ?? checkLinkState;
  const fetchPage = deps.fetchPage ?? fetchSourcePage;
  const [dead, read] = await Promise.all([
    Promise.all(links.map(async (url) => ((await check(url).catch(() => "unknown" as const)) === "dead" ? url : null))),
    Promise.all(sources.map(async (s) => ({ s, page: await fetchPage(s.url).catch(() => null) }))),
  ]);
  const evidence: Omit<ReviewEvidence, "id">[] = [];
  const deadSet = new Set(dead.filter((u): u is string => Boolean(u)));
  for (const url of deadSet) evidence.push({ kind: "dead_link", text: "This link no longer opens (the site answers that the page is gone).", url, year: null, detail: "" });
  for (const { s, page } of read) {
    if (!page || page.refused || deadSet.has(s.url)) continue;
    if (samePage(page.url, s.url) === false) {
      evidence.push({ kind: "source_moved", text: s.fact, url: s.url, year: s.year, detail: `Now at ${page.url}` });
    } else if (page.text && !factFiguresOnPage(s.fact, page.text)) {
      evidence.push({ kind: "source_changed", text: s.fact, url: s.url, year: s.year, detail: `${s.publisher || s.title}: the page no longer shows this figure.` });
    }
  }
  return { evidence };
}

/** False when a page now answers at a different address (another site, or another path). */
function samePage(now: string, was: string): boolean {
  try {
    const a = new URL(now);
    const b = new URL(was);
    return bareHost(a.hostname) === bareHost(b.hostname) && a.pathname.replace(/\/+$/, "") === b.pathname.replace(/\/+$/, "");
  } catch {
    return true;
  }
}

// ---- Step 3: research ------------------------------------------------------------------------

const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();

/** A question the article already answers: its heading or FAQ question shares most of its words. */
function answeredIn(question: string, headings: string[]): boolean {
  const q = wordsOf(question);
  if (!q.size) return true;
  return headings.some((h) => {
    if (norm(h) === norm(question)) return true;
    const w = wordsOf(h);
    let shared = 0;
    for (const x of q) if (w.has(x)) shared += 1;
    return shared / q.size >= 0.6;
  });
}

async function researchStep(ctx: TenantContext, { review, plan, usage, deadlineMs }: StepInput, deps: ReviewDeps): Promise<StepResult> {
  const ws = await forTenant(ctx, deps.db).workspaces.getById(plan.workspaceId).catch(() => null);
  if (!ws) return { error: "article_gone" };
  const [brand, map] = await Promise.all([(deps.brand ?? tenantBrand)(ctx), loadArticleMap(ctx, { db: deps.db }, { pages: true, planId: plan.id, ask: askOfPlan(plan) }).catch(() => null)]);
  const timeoutMs = Math.max(10_000, Math.min(REVIEW.RESEARCH_MS, deadlineMs - Date.now() - 5_000));
  const research = deps.research ?? researchBlogBrief;
  const result = await research({ ctx, workspace: { id: ws.id, name: ws.name, audience: ws.audience ?? null }, plan, brandName: brand.name, ownSites: brand.sites, timeoutMs, map }, { usage });
  const figures = new Set(review.reading?.figures ?? []);
  const cited = new Set((plan.blog?.sources ?? []).map((s) => s.url));
  const thisYear = nowOf(deps).getUTCFullYear();
  const evidence: Omit<ReviewEvidence, "id">[] = [];
  for (const s of result.brief.sources) {
    if (evidence.length >= REVIEW.MAX_NEW_FACTS) break;
    if (s.status === "unverified" || !s.fact || (s.year !== null && s.year < thisYear - 1)) continue;
    const cores = articleFigures(s.fact).map((f) => f.core);
    if (!cores.length || (cited.has(s.url) && cores.every((c) => figures.has(c)))) continue;
    evidence.push({ kind: "new_fact", text: s.fact, url: s.url, year: s.year, detail: [s.publisher || s.title, s.status === "verified" ? "figure found on the page" : ""].filter(Boolean).join(", ") });
  }
  const headings = review.reading?.headings ?? [];
  const planned = new Set((plan.blog?.questions ?? []).map((q) => norm(q.question)));
  for (const q of result.brief.questions) {
    if (evidence.filter((e) => e.kind === "new_question").length >= REVIEW.MAX_QUESTIONS) break;
    if (planned.has(norm(q.question)) || answeredIn(q.question, headings)) continue;
    evidence.push({ kind: "new_question", text: q.question, url: null, year: null, detail: "Asked now, found by research" });
  }
  return { evidence, notes: result.searchLimited ? [REVIEW_NOTES.searchLimited] : [] };
}

// ---- Step 4: brand and numbers ---------------------------------------------------------------

async function defaultOpenQuestions(ctx: TenantContext, subjectId: string, db?: FirestoreLike): Promise<string[]> {
  const read = await readBrandMap(ctx, db).catch(() => null);
  if (!read || read.state !== "ok") return [];
  if (isBrandMapScaleEnabled() && read.map.moved) {
    const cov = await subjectCoverage(ctx, subjectId, { db }).catch(() => null);
    return (cov?.coverage.questions ?? []).filter((q) => q.state === "open").map((q) => q.text);
  }
  const rows = await listBrandMapPages(ctx, db).catch(() => [] as BrandMapPage[]);
  const s = computeCoverage(read.map, rows).subjects.find((x) => x.id === subjectId);
  return (s?.questions ?? []).filter((q) => q.state === "open").map((q) => q.text);
}

const SEARCH_STREAM = searchConsoleManifest.produces[0]!.stream;

/** The searches that land on this page, read live from a Search Console connection that feeds planning. */
export async function defaultPageSearches(ctx: TenantContext, liveUrl: string, db?: FirestoreLike): Promise<PageSearches> {
  let url: URL;
  try {
    url = new URL(liveUrl);
  } catch {
    return { rows: [], note: REVIEW_NOTES.noSearchConsole };
  }
  const conns = [...(await planningConnections(ctx, { db }).catch(() => new Map())).values()];
  const conn = conns.find((c) => c.account && accountCovers(c.account, url.hostname));
  if (!conn) return { rows: [], note: REVIEW_NOTES.noSearchConsole };
  const r = await readLiveFor(ctx, { kind: "job", job: "article_review" }, conn.id, { stream: SEARCH_STREAM, period: "last_28_days", by: "topic", page: url.pathname || "/", limit: 50 }, { db }).catch(() => null);
  if (!r?.ok) return { rows: [], note: REVIEW_NOTES.searchConsoleFailed };
  const rows = r.value.rows
    .map((row) => ({
      query: String(row.label ?? row.key ?? "").slice(0, 200),
      impressions: Number(row.searchImpressions ?? 0),
      clicks: Number(row.searchClicks ?? 0),
      position: typeof row.searchPosition === "number" ? row.searchPosition : null,
    }))
    .filter((x) => x.query);
  return { rows, note: null };
}

async function brandStep(ctx: TenantContext, { review, plan, usage }: StepInput, deps: ReviewDeps): Promise<StepResult> {
  const brief = plan.blog;
  const headings = review.reading?.headings ?? [];
  const question = (brief?.primaryQuestion ?? "").trim() || plan.name;
  const evidence: Omit<ReviewEvidence, "id">[] = [];
  const notes: string[] = [];
  const subjectId = brief?.subjectId ?? null;

  const [open, knowledge, searches, seen] = await Promise.all([
    subjectId ? (deps.openQuestions ?? ((c, id) => defaultOpenQuestions(c, id, deps.db)))(ctx, subjectId).catch(() => [] as string[]) : Promise.resolve([] as string[]),
    (deps.retrieve ?? retrieveSemanticKnowledgeContext)({ ctx, ownerKind: "workspace", ownerId: plan.workspaceId, queryText: question, limit: 6, bypassEnabledFlag: true }).catch(() => null),
    review.reading?.liveUrl ? (deps.pageSearches ?? ((c, u) => defaultPageSearches(c, u, deps.db)))(ctx, review.reading.liveUrl).catch(() => ({ rows: [], note: REVIEW_NOTES.searchConsoleFailed })) : Promise.resolve(null),
    isSeenOn() && brief
      ? (deps.seen ?? matchSeen)(ctx, { plan, brief, brandName: brief.publisherName.trim() || plan.name }, { db: deps.db, usage }).catch(() => null)
      : Promise.resolve(null),
  ]);

  for (const q of open) {
    if (evidence.length >= REVIEW.MAX_QUESTIONS) break;
    if (!answeredIn(q, headings)) evidence.push({ kind: "open_question", text: q, url: null, year: null, detail: "Open on your brand map, on this article's subject" });
  }
  for (const c of (knowledge?.chunks ?? []).slice(0, 4)) {
    evidence.push({ kind: "product_fact", text: c.content.replace(/\s+/g, " ").slice(0, 500), url: c.sourceUri || null, year: null, detail: c.title || c.heading || "" });
  }
  if (searches) {
    if (searches.note) notes.push(searches.note);
    const unanswered = searches.rows
      .filter((s) => s.impressions >= REVIEW.MIN_IMPRESSIONS && !answeredIn(s.query, headings))
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, REVIEW.MAX_SEARCHES);
    for (const s of unanswered) {
      const pos = s.position === null ? "" : `, position ${s.position.toFixed(1)}`;
      evidence.push({ kind: "page_search", text: s.query, url: null, year: null, detail: `${s.impressions.toLocaleString("en-US")} impressions, ${s.clicks.toLocaleString("en-US")} clicks${pos} in 28 days, and the page doesn't answer it` });
    }
  }
  const used = new Set([...(brief?.seen?.notes ?? []).map((n) => n.id), ...(brief?.seen?.removed ?? [])]);
  for (const n of (seen?.notes ?? []).filter((x) => !used.has(x.id)).slice(0, 2)) {
    evidence.push({ kind: "note", text: n.text.slice(0, 600), url: null, year: null, detail: n.why || "From What we've seen" });
  }
  return { evidence, notes };
}

// ---- The tick's lane -------------------------------------------------------------------------

export interface ReviewTickResult {
  brands: number;
  advanced: number;
}

/** Move running reviews on, a few a tick, within the budget. */
export async function runRefreshReviews(opts: { deadlineMs: number }, deps: ReviewDeps = {}): Promise<ReviewTickResult> {
  const result: ReviewTickResult = { brands: 0, advanced: 0 };
  if (!isBlogRefreshEnabled()) return result;
  const tenants = await (deps.listTenants ?? listAllTenants)();
  for (const t of tenants) {
    if (result.advanced >= REVIEW.PER_TICK || opts.deadlineMs - Date.now() < REVIEW.STEP_MS.read) break;
    if (t.status === "suspended") continue;
    const ctx: TenantContext = { tenantId: t.id, region: t.region, source: "system" };
    try {
      const running = await repoOf(ctx, deps).find({ where: [["active", "==", true]], limit: 5 });
      if (!running.length) continue;
      result.brands += 1;
      for (const r of running) {
        if (result.advanced >= REVIEW.PER_TICK || !r.step) break;
        if (Date.parse(r.nextAt) > nowOf(deps).getTime() || opts.deadlineMs - Date.now() < REVIEW.STEP_MS[r.step]) continue;
        if (await advanceReview(ctx, r.planId, opts, deps)) result.advanced += 1;
      }
    } catch (err) {
      console.warn(`[refresh] ${t.id} failed:`, err instanceof Error ? err.message.slice(0, 200) : "error");
    }
  }
  return result;
}
