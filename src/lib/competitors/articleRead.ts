import { z } from "zod";
import { generateTextWithDeadline, parseFirstJson } from "@/lib/agents/gemini";
import { renderPrompt } from "@/lib/agents/prompts/registry";
import type { ArticleMap } from "@/lib/content/blog/articleMap";
import {
  ARTICLE_ASK_KINDS,
  ARTICLE_ASK_PLACES,
  ARTICLE_FORMATS,
  ARTICLE_LINK_ROLES,
  ARTICLE_STAGES,
  type ArticleCta,
  type ArticleLinkRead,
  type ArticleLinkRole,
  type ArticleStat,
  type CompetitorArticle,
} from "@/lib/types/competitor";
import { fenced, tidy, type AnalyseDeps } from "./analyse";
import type { ArticlePage } from "./article";
import { readerOf, wasRead, type GoogleDeps } from "./google";

/**
 * Gemini reads one competitor article and says what it covers, who it is for, the numbers it uses
 * and what its links do. Nothing it says is taken on trust:
 *
 * - links are named by number, and every address comes from our own reading of the page;
 * - a stat is kept only when it is a measured result and its sentence is found, word for word, in the article;
 * - brand map ids must be ones we offered;
 * - your names and other competitors' names are found in the text by code, not by the model.
 *
 * A site that turns us away is read through Google: topic and reader only, because there is no
 * text of ours to check a quote, a link or an ask against.
 */

/**
 * Bumped when what a read records changes. An article read by an older version is read again when
 * nothing new is waiting (see articleTick.ts). 2: stats are measured results only.
 */
export const READER_VERSION = { direct: 2, google: 1 } as const;

/** Whether an article was read by an older reader than today's, so reading it again would change it. */
export function readByOlderReader(a: Pick<CompetitorArticle, "status" | "readBy" | "version">): boolean {
  return a.status === "read" && (a.version ?? 0) < READER_VERSION[a.readBy ?? "direct"];
}
/** Reading needs little thinking, and none keeps a read inside its time (6 to 9 seconds measured). */
const THINKING = 0;
/**
 * Kept back for a second try. Plain JSON, not a response schema: measured on real articles, a
 * schema call sometimes looped on a list until its deadline, and capping its lists was refused as
 * an invalid argument, while plain JSON answered in 3 to 6 seconds every time. Code checks it all.
 */
const RETRY_MS = 8_000;

export interface ReadDeps extends AnalyseDeps, GoogleDeps {
  /** Milliseconds now (tests). */
  clock?: () => number;
}

export interface ReadCandidates {
  subjects: Array<{ id: string; name: string }>;
  situations: Array<{ id: string; text: string }>;
  audiences: Array<{ id: string; name: string }>;
  /** The brand's own names: found in the text by code. */
  ownNames: string[];
  /** Other competitors on the brand map: found in the text by code. */
  otherNames: string[];
}

export type ArticleFindings = Pick<
  CompetitorArticle,
  | "summary"
  | "question"
  | "angle"
  | "newTopic"
  | "format"
  | "stage"
  | "subjectIds"
  | "situationIds"
  | "audienceIds"
  | "reader"
  | "stats"
  | "sources"
  | "links"
  | "asks"
  | "mentions"
>;

const MAX = { SUBJECTS: 12, SITUATIONS: 8, AUDIENCES: 12, STATS: 25, LINKS: 60, ASKS: 10, SOURCES: 20, PRODUCTS: 8 } as const;

/** What the brand map offers one article: the subjects and situations near it, and its names. */
export function candidatesFrom(map: ArticleMap | null, opts: { brandName: string; competitorNameId: string | null; competitorName: string }): ReadCandidates {
  const names = map?.names ?? [];
  const spellings = (kind: string, keep: (n: (typeof names)[number]) => boolean = () => true) =>
    names.filter((n) => n.kind === kind && keep(n)).flatMap((n) => [n.name, ...n.aliases]);
  const situations = map?.situations?.length ? map.situations : map?.situation ? [map.situation] : [];
  const own = (map?.identity.name || opts.brandName).trim();
  const theirs = opts.competitorName.trim().toLowerCase();
  return {
    subjects: (map?.subjects ?? []).slice(0, MAX.SUBJECTS).map((s) => ({ id: s.id, name: s.name })),
    situations: situations.slice(0, MAX.SITUATIONS).map((s) => ({ id: s.id, text: s.who ? `${s.text} (${s.who})` : s.text })),
    audiences: names.filter((n) => n.kind === "audience").slice(0, MAX.AUDIENCES).map((n) => ({ id: n.id, name: n.name })),
    ownNames: [...new Set([own, ...spellings("product")].filter(Boolean))],
    otherNames: [...new Set(spellings("alternative", (n) => n.id !== opts.competitorNameId && n.name.trim().toLowerCase() !== theirs))],
  };
}

const lines = (rows: string[]) => (rows.length ? rows.join("\n") : "(none)");

function mapVars(cand: ReadCandidates) {
  return {
    subjects: lines(cand.subjects.map((s) => `- ${s.id}: ${fenced(s.name)}`)),
    situations: lines(cand.situations.map((s) => `- ${s.id}: ${fenced(s.text)}`)),
    audiences: lines(cand.audiences.map((a) => `- ${a.id}: ${fenced(a.name)}`)),
  };
}

// ---------------------------------------------------------------------------------------------
// Checking what came back
// ---------------------------------------------------------------------------------------------

const Text = z.string().catch("");
const List = z.array(z.unknown()).catch([]);
const Raw = z.object({
  summary: Text,
  question: Text,
  angle: Text,
  newTopic: Text.optional(),
  format: Text.optional(),
  stage: Text.optional(),
  subjectIds: z.array(z.string()).catch([]).optional(),
  situationIds: z.array(z.string()).catch([]).optional(),
  audienceIds: z.array(z.string()).catch([]).optional(),
  reader: z.object({ roles: z.array(z.string()).catch([]), companies: Text, pains: z.array(z.string()).catch([]) }).partial().catch({}).optional(),
  stats: List.optional(),
  links: List.optional(),
  ctas: List.optional(),
  productsPushed: z.array(z.string()).catch([]).optional(),
});
/** What a number in an article is. Only a result is evidence; the rest are named so the model has somewhere to put them. */
const STAT_KINDS = ["result", "setup", "setting", "price", "date", "example"] as const;
const Stat = z.object({
  figure: z.string(),
  about: Text,
  quote: z.string(),
  kind: z.enum(STAT_KINDS),
  theirOwn: z.boolean().catch(false),
  sourceLink: z.number().int().catch(0).optional(),
});

const MONTHS = /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|june?|july?|aug(ust)?|sep(t|tember)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/i;
/** "May" is a month only beside a number ("May 2026", "8 May"), not in "may rise". */
const MAY = /\bmay\s+\d|\d(st|nd|rd|th)?\s+may\b/i;

/** A figure that is a date ("June 30, 2026", "2026-11"), whatever the model called it. */
export function isDateFigure(figure: string): boolean {
  return MONTHS.test(figure) || MAY.test(figure) || /\b(19|20)\d\d-\d\d\b/.test(figure);
}

const LinkRole = z.object({ n: z.number().int(), role: z.enum(ARTICLE_LINK_ROLES) });
const Cta = z.object({ n: z.number().int(), kind: z.enum(ARTICLE_ASK_KINDS), placement: z.enum(ARTICLE_ASK_PLACES) });

/** Text compared for quotes: link marks out, curly quotes and spaces made plain, lower case. */
export function plain(s: string): string {
  return s
    .replace(/\[L\d+\]/g, " ")
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[\s ]+/g, " ")
    .trim()
    .toLowerCase();
}

function quoteFound(hay: string, quote: string, figure: string): boolean {
  const q = plain(quote).replace(/^["'\s]+|["'.\s]+$/g, "");
  return q.length >= 8 && hay.includes(q) && q.includes(plain(figure));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Names found in the text as whole words. */
function namesIn(text: string, names: string[]): string[] {
  const t = plain(text);
  return [...new Set(names.filter((n) => n.trim().length >= 3 && new RegExp(`(^|[^\\p{L}\\p{N}])${escape(plain(n))}($|[^\\p{L}\\p{N}])`, "u").test(t)))];
}

const ASK_WORDS: Array<[ArticleCta["kind"], RegExp]> = [
  ["demo", /\bdemo\b|book a call/i],
  ["trial", /\btrial\b|start (for )?free|try (it )?(for )?free/i],
  ["contact_sales", /contact|talk to (sales|us|an expert)|get in touch/i],
  ["download", /download|free copy|get the (report|guide|ebook|template)/i],
  ["newsletter", /newsletter|subscribe/i],
  ["webinar", /webinar|register for/i],
  ["pricing", /pricing|see plans/i],
  ["sign_up", /sign ?up|get started|create (an |your )?account|join (now|free)/i],
];

/** What a link asks for, from its own words and address. */
function askKindOf(link: { anchor: string; url: string }): ArticleCta["kind"] | null {
  const words = `${link.anchor} ${link.url}`;
  return ASK_WORDS.find(([, re]) => re.test(words))?.[0] ?? null;
}

/** Where a link sits in the article: its first lines, its last lines, or between. */
function placementOf(text: string, n: number): ArticleCta["placement"] {
  const at = text.indexOf(`[L${n}]`);
  if (at < 0 || !text.length) return "inline";
  const share = at / text.length;
  return share < 0.15 ? "top" : share > 0.8 ? "end" : "inline";
}

const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};

function pick<T extends string>(raw: string | undefined, allowed: readonly T[]): T | null {
  return allowed.includes(raw as T) ? (raw as T) : null;
}

/**
 * The model's answer, checked against the page and the ids we offered. With no page (read through
 * Google) there is nothing to check a quote or a link against, so none are kept. Null when the
 * answer says nothing usable.
 */
export function checkFindings(raw: unknown, page: ArticlePage | null, cand: ReadCandidates): ArticleFindings | null {
  const parsed = Raw.safeParse(raw);
  if (!parsed.success) return null;
  const r = parsed.data;
  const summary = tidy(r.summary, 400);
  if (!summary) return null;

  const within = (got: string[] | undefined, offered: Array<{ id: string }>, max: number) => {
    const ok = new Set(offered.map((o) => o.id));
    return [...new Set((got ?? []).filter((id) => ok.has(id)))].slice(0, max);
  };
  const subjectIds = within(r.subjectIds, cand.subjects, 5);
  const newTopic = subjectIds.length ? null : tidy(r.newTopic ?? "", 60).split(" ").slice(0, 6).join(" ") || null;
  const short = (list: string[] | undefined, n: number, len: number) => [...new Set((list ?? []).map((s) => tidy(s, len)).filter(Boolean))].slice(0, n);

  const base: ArticleFindings = {
    summary,
    question: tidy(r.question, 200),
    angle: tidy(r.angle, 280),
    newTopic,
    format: pick(r.format, ARTICLE_FORMATS),
    stage: pick(r.stage, ARTICLE_STAGES),
    subjectIds,
    situationIds: within(r.situationIds, cand.situations, 3),
    audienceIds: within(r.audienceIds, cand.audiences, 3),
    reader: { roles: short(r.reader?.roles, 6, 60), companies: tidy(r.reader?.companies ?? "", 160), pains: short(r.reader?.pains, 5, 160) },
    stats: [],
    sources: [],
    links: [],
    asks: [],
    mentions: { you: [], others: [], products: short(r.productsPushed, MAX.PRODUCTS, 60) },
  };
  if (!page) return base;

  const byN = new Map(page.links.map((l) => [l.n, l]));
  const hay = plain(page.text);
  const stats: ArticleStat[] = [];
  for (const item of r.stats ?? []) {
    const s = Stat.safeParse(item);
    // Only a measured result counts as a stat: not a date, a test's set up, a setting, a price or an example.
    if (!s.success || s.data.kind !== "result" || isDateFigure(s.data.figure) || !quoteFound(hay, s.data.quote, s.data.figure)) continue;
    const link = s.data.sourceLink ? byN.get(s.data.sourceLink) : undefined;
    const source = link && !link.internal ? { url: link.url, domain: domainOf(link.url) } : null;
    stats.push({
      figure: s.data.figure.trim().slice(0, 40),
      about: tidy(s.data.about, 160),
      quote: s.data.quote.replace(/\s*\[L\d+\]\s*/g, " ").replace(/\s+/g, " ").trim().slice(0, 300),
      // A number an outside page backs isn't the competitor's own.
      theirOwn: source ? false : s.data.theirOwn,
      source,
    });
    if (stats.length >= MAX.STATS) break;
  }

  const roles = new Map<number, ArticleLinkRole>();
  for (const item of r.links ?? []) {
    const l = LinkRole.safeParse(item);
    if (l.success && byN.has(l.data.n)) roles.set(l.data.n, l.data.role);
  }

  // Asks: the ones the model listed, and any link it called an ask. Where each sits comes from
  // the page itself; what it asks for from the model, else from the link's own words.
  const asks: ArticleCta[] = [];
  const askUrls = new Set<string>();
  const kinds = new Map<number, ArticleCta["kind"]>();
  for (const item of r.ctas ?? []) {
    const c = Cta.safeParse(item);
    if (c.success && byN.has(c.data.n)) kinds.set(c.data.n, c.data.kind);
  }
  for (const [n, role] of roles) if (role === "ask" && !kinds.has(n)) kinds.set(n, askKindOf(byN.get(n)!) ?? "other");
  for (const [n, kind] of [...kinds].sort((a, b) => a[0] - b[0])) {
    const link = byN.get(n)!;
    if (askUrls.has(link.url) || asks.length >= MAX.ASKS) continue;
    askUrls.add(link.url);
    asks.push({ kind, placement: placementOf(page.text, n), url: link.url, text: link.anchor });
  }

  const links: ArticleLinkRead[] = page.links.slice(0, MAX.LINKS).map((l) => ({
    url: l.url,
    anchor: l.anchor,
    internal: l.internal,
    role: askUrls.has(l.url) ? "ask" : (roles.get(l.n) ?? (l.inAside ? "related" : "in_text")),
  }));

  const seen = new Set<string>();
  const sources = links
    .filter((l) => !l.internal && (l.role === "source" || l.role === "in_text" || l.role === "other"))
    .filter((l) => (seen.has(l.url) ? false : (seen.add(l.url), true)))
    .slice(0, MAX.SOURCES)
    .map((l) => ({ url: l.url, domain: domainOf(l.url), anchor: l.anchor }));

  return {
    ...base,
    stats,
    sources,
    links,
    asks,
    mentions: { ...base.mentions, you: namesIn(page.text, cand.ownNames), others: namesIn(page.text, cand.otherNames) },
  };
}

// ---------------------------------------------------------------------------------------------
// The two reads
// ---------------------------------------------------------------------------------------------

/** Read a page we fetched ourselves. Null when the model gave nothing usable in time. */
export async function readArticle(
  page: ArticlePage,
  cand: ReadCandidates,
  opts: { name: string; timeoutMs: number },
  deps: ReadDeps = {},
): Promise<ArticleFindings | null> {
  const clock = deps.clock ?? Date.now;
  const end = clock() + opts.timeoutMs;
  const prompt = renderPrompt("competitors.read_article", {
    name: fenced(opts.name),
    title: fenced(page.title),
    text: fenced(page.text),
    ...mapVars(cand),
  });
  const generate = deps.generate ?? generateTextWithDeadline;
  let raw = await generate(prompt, { timeoutMs: Math.max(1, end - clock() - RETRY_MS), json: true, thinkingBudget: THINKING });
  // A slow or empty answer: once more, while there's time.
  if (!raw && end - clock() >= RETRY_MS) raw = await generate(prompt, { timeoutMs: end - clock(), json: true, thinkingBudget: THINKING });
  return raw ? checkFindings(parseFirstJson(raw), page, cand) : null;
}

/** Read an article on a site that turns us away, through Google. Topic and reader only. */
export async function readArticleWithGoogle(
  url: string,
  cand: ReadCandidates,
  opts: { name: string; timeoutMs: number },
  deps: ReadDeps = {},
): Promise<ArticleFindings | null> {
  const prompt = renderPrompt("competitors.read_article_google", { url, name: fenced(opts.name), ...mapVars(cand) });
  const res = await readerOf(deps)(prompt, { timeoutMs: opts.timeoutMs, thinkingBudget: THINKING });
  if (!res || !wasRead(res, url)) return null;
  const parsed = parseFirstJson(res.text) as { unread?: unknown } | null;
  if (!parsed || parsed.unread) return null;
  return checkFindings(parsed, null, cand);
}
