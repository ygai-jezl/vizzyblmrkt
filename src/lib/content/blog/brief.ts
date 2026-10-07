import {
  BlogBriefSchema,
  CONTENT_PLAN_LIMITS,
  type BlogBrief,
  type BlogEntity,
  type BlogLink,
  type BlogQuestion,
  type BlogSource,
} from "@/lib/types/contentPlan";

/**
 * The blog hub's brief, and the small rules everything else leans on: which sources the
 * writer may be given, which URLs an article may carry, how a researched brief merges
 * with what a person already typed, and how the brief is laid out in a prompt. Pure +
 * client-safe.
 */

export const EMPTY_BLOG_BRIEF: BlogBrief = BlogBriefSchema.parse({});

/** A plan's brief, or an empty one — so callers never branch on null. */
export function briefOf(plan: { blog?: BlogBrief | null }): BlogBrief {
  return plan.blog ?? EMPTY_BLOG_BRIEF;
}

/**
 * One spelling per URL, for comparing links: lower-case host, no fragment, no tracking
 * parameters, no trailing slash. Returns "" for anything that is not an http(s) URL.
 */
export function normalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL((raw ?? "").trim());
  } catch {
    return "";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "";
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_[a-z]+|gclid|fbclid|mc_[a-z]+|ref|ref_src)$/i.test(key)) url.searchParams.delete(key);
  }
  const path = url.pathname.replace(/\/+$/, "");
  const query = url.searchParams.toString();
  return `${url.protocol}//${url.host.toLowerCase()}${path}${query ? `?${query}` : ""}`;
}

/** A URL's host without "www.", or "" when it is not a URL. */
export function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** A page on a code host is the brand's source code, never a page to send a reader to. */
export function isCodeHostUrl(raw: string): boolean {
  return /^(github\.com|gitlab\.com|bitbucket\.org)$/.test(hostOf(raw));
}

/** The sources the writer is given: checked on the page, or put there by a person. */
export function usableSources(brief: BlogBrief): BlogSource[] {
  return brief.sources.filter((s) => s.status !== "unverified" && s.url && s.fact.trim());
}

/**
 * Every URL an article written from this brief may carry, normalized: the brief's own
 * rows as they are (a person or research put them there), plus `extra` — the pages the
 * knowledge search returned — minus any on a code host, which are the brand's source
 * files, not pages to send a reader to.
 */
export function allowedUrls(brief: BlogBrief, extra: (string | null | undefined)[] = []): Set<string> {
  const out = new Set<string>();
  for (const raw of [...brief.links.map((l) => l.url), ...usableSources(brief).map((s) => s.url)]) {
    const n = normalizeUrl(raw);
    if (n) out.add(n);
  }
  for (const raw of extra) {
    const n = raw ? normalizeUrl(raw) : "";
    if (n && !isCodeHostUrl(n)) out.add(n);
  }
  return out;
}

/** The hosts that are the brand's own: where its link targets and its publisher URL live. */
export function ownHosts(brief: BlogBrief, extra: (string | null | undefined)[] = []): Set<string> {
  const out = new Set<string>();
  for (const raw of [...brief.links.map((l) => l.url), brief.publisherUrl, ...extra]) {
    const h = raw ? hostOf(raw) : "";
    if (h) out.add(h);
  }
  return out;
}

function dedupe<T>(rows: T[], key: (row: T) => string, max: number): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const k = key(row);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(row);
    if (out.length >= max) break;
  }
  return out;
}

/** Letters and digits of any script, so two spellings of one question — in any language —
 *  compare equal (and a question in Japanese is not mistaken for an empty one). */
const textKey = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** What research found, before it is merged into a brief. */
export interface BlogResearchFindings {
  primaryQuestion: string;
  questions: BlogQuestion[];
  links: BlogLink[];
  sources: BlogSource[];
  entities: BlogEntity[];
  publisherName: string;
  publisherUrl: string;
}

/**
 * Merge fresh research into a brief. A person's rows always stay, and come first;
 * research replaces only its own earlier rows. What the operator typed (the primary
 * question, the publisher, the author) is never overwritten — research only fills blanks.
 */
export function mergeResearch(current: BlogBrief, found: BlogResearchFindings, researchedAt: string): BlogBrief {
  const mine = <T extends { by: "research" | "operator" }>(rows: T[]) => rows.filter((r) => r.by === "operator");
  // A source a person added or confirmed is theirs, however it first arrived.
  const keptSources = current.sources.filter((s) => s.status === "operator");
  return BlogBriefSchema.parse({
    ...current,
    primaryQuestion: current.primaryQuestion.trim() || found.primaryQuestion.trim().slice(0, 300),
    questions: dedupe(
      [...mine(current.questions), ...found.questions],
      (q) => textKey(q.question),
      CONTENT_PLAN_LIMITS.MAX_BLOG_QUESTIONS,
    ),
    links: dedupe([...mine(current.links), ...found.links], (l) => normalizeUrl(l.url), CONTENT_PLAN_LIMITS.MAX_BLOG_LINKS),
    sources: dedupe(
      [...keptSources, ...found.sources],
      (s) => `${normalizeUrl(s.url)}|${textKey(s.fact)}`,
      CONTENT_PLAN_LIMITS.MAX_BLOG_SOURCES,
    ),
    entities: dedupe(
      [...mine(current.entities), ...found.entities],
      (e) => textKey(e.name),
      CONTENT_PLAN_LIMITS.MAX_BLOG_ENTITIES,
    ),
    publisherName: current.publisherName.trim() || found.publisherName.trim().slice(0, 120),
    publisherUrl: current.publisherUrl || found.publisherUrl,
    researchedAt,
  });
}

/**
 * Everything a blog hub's writer is given, as one text — the only places a figure in the
 * copy may come from. The writer's check and the fact check both read figures against
 * this, so they can never disagree about what counts as traceable.
 */
export function blogReference(args: {
  plan: { scope: { spark: string }; strategy: { subscriberCount?: number | null } };
  nodeBrief?: string | null;
  brief: BlogBrief;
  knowledgeContext: string;
  proofBlock: string;
}): string {
  const { plan, brief } = args;
  return [
    args.knowledgeContext,
    args.proofBlock,
    plan.scope.spark,
    args.nodeBrief ?? "",
    brief.primaryQuestion,
    brief.buyerQuestions,
    ...brief.questions.map((q) => q.question),
    ...usableSources(brief).map((s) => `${s.fact} ${s.year ?? ""} ${s.title}`),
    plan.strategy.subscriberCount != null ? String(plan.strategy.subscriberCount) : "",
  ].join("\n");
}

// ── The brief, laid out for a prompt ────────────────────────────────────────

const INTENT_LABEL: Record<BlogQuestion["intent"], string> = {
  definition: "what it is",
  how_to: "how to do it",
  alternatives: "alternatives",
  comparison: "comparison",
  integrations: "integrations",
  use_cases: "use cases",
  pricing: "pricing",
  limits: "limits",
  benchmarks: "benchmarks",
  other: "related",
};

const LINK_LABEL: Record<BlogLink["intent"], string> = {
  convert: "CONVERSION page",
  product: "product page",
  proof: "customer proof",
  compare: "comparison page",
  learn: "goes deeper",
};

const RELATION_LABEL: Record<BlogEntity["relation"], string> = {
  brand: "the brand",
  product: "the brand's product",
  category: "the category it belongs to",
  alternative: "an alternative in the category",
  integration: "something it integrates with",
  audience: "who it is for",
  use_case: "a use case",
};

/** One line per row; a single line of text can't open a new prompt section. */
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export function formatQuestions(brief: BlogBrief): string {
  if (!brief.questions.length) return "(none listed — choose the 5-7 questions a buyer asks next)";
  return brief.questions.map((q) => `- ${oneLine(q.question)} [${INTENT_LABEL[q.intent]}]`).join("\n");
}

export function formatLinks(links: BlogLink[]): string {
  if (!links.length) return "(none — write no internal links)";
  return links
    .map((l) => `- ${oneLine(l.label) || hostOf(l.url)} — ${l.url} [${LINK_LABEL[l.intent]}]`)
    .join("\n");
}

/** The name a citation is written under: the site's own name, else its domain. */
export function citationName(source: Pick<BlogSource, "publisher" | "url">): string {
  return oneLine(source.publisher) || hostOf(source.url);
}

export function formatSources(sources: BlogSource[]): string {
  if (!sources.length) return "(none — write no third-party citations and state no third-party statistics)";
  return sources
    .map((s) => {
      const cite = `[${citationName(s)}${s.year ? `, ${s.year}` : ""}](${s.url})`;
      const title = oneLine(s.title) ? ` — "${oneLine(s.title)}"` : "";
      return `- Cite as ${cite}${title}\n  It says: ${oneLine(s.fact)}`;
    })
    .join("\n");
}

export function formatEntities(entities: BlogEntity[]): string {
  if (!entities.length) return "";
  return entities.map((e) => `- ${oneLine(e.name)} — ${RELATION_LABEL[e.relation]}`).join("\n");
}
