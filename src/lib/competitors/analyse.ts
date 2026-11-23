import { z } from "zod";
import { generateGroundedText, generateTextWithDeadline, isSearchLimited, parseFirstJson, type AiUsage, type SearchLimited } from "@/lib/agents/gemini";
import { renderPrompt } from "@/lib/agents/prompts/registry";
import { stripFenceDelimiters } from "@/lib/content/create/siteText";
import { aiTellsIn } from "@/lib/content/writingRules";
import type { CompetitorAnalysis, CompetitorStats, SectionCount } from "@/lib/types/competitor";
import { samplePaths, type NewsCandidate } from "./shape";
import { onSite, type BaselinePage } from "./sitemap";
import type { SiteDiff } from "./diff";

/**
 * What Gemini does for Competitors: find a sitemap and news page with search (only when the usual
 * addresses have none), put words to a site's shape, and say what a week's posts or a month's
 * changes are about. Code counts; the model only labels. Every path it names must be one we read,
 * or that item is dropped. Each call has a deadline, and without a model each falls back to words
 * written by code (or to nothing), never to a guess.
 */

export interface AnalyseDeps {
  generate?: (prompt: string, opts: { timeoutMs: number; json: boolean; thinkingBudget?: number; usage: AiUsage }) => Promise<string | null>;
  grounded?: (prompt: string, opts: { timeoutMs: number; thinkingBudget?: number; usage: AiUsage }) => Promise<{ text: string } | SearchLimited | null>;
}

/** Thinking is capped so a call fits the step's time. */
const THINKING = 1024;

/** Someone else's text, inside our <site_text> fence: it can't close the fence early. */
export function fenced(text: string): string {
  return stripFenceDelimiters(text);
}

/** House style: a dash used as punctuation becomes a comma (the prompt asks for none; this is the backstop). */
export function tidy(text: string, max: number): string {
  return text
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/(?<=\S) - (?=\S)/g, ", ")
    .replace(/\s+/g, " ")
    .replace(/^[,\s]+|[,\s]+$/g, "")
    .slice(0, max)
    .trim();
}

/** Copy with an AI tell in it is dropped rather than shown (a sentence is not worth a tell). */
function clean(text: string, max: number): string {
  const t = tidy(text, max);
  return aiTellsIn(t).length ? "" : t;
}

// ---------------------------------------------------------------------------------------------
// Finding a sitemap and news page with search
// ---------------------------------------------------------------------------------------------

export interface SearchFound {
  sitemap: string | null;
  news: string | null;
}

/** The two lines the search prompt answers with. Addresses off the competitor's site are dropped. */
export function readFoundLines(text: string, site: string): SearchFound {
  const pick = (label: string): string | null => {
    const m = new RegExp(`^\\s*${label}\\s*:\\s*(\\S+)`, "im").exec(text);
    const url = (m?.[1] ?? "").replace(/[)\].,>]+$/, "");
    return /^https?:\/\//i.test(url) && onSite(url, site) ? url.replace(/^http:\/\//i, "https://") : null;
  };
  return { sitemap: pick("SITEMAP"), news: pick("NEWS") };
}

export async function searchForSite(
  input: { name: string; website: string; site: string },
  timeoutMs: number,
  usage: AiUsage,
  deps: AnalyseDeps = {},
): Promise<SearchFound | null> {
  const prompt = renderPrompt("competitors.find_site", { name: input.name, website: input.website, site: input.site });
  const res = await (deps.grounded ?? generateGroundedText)(prompt, { timeoutMs, thinkingBudget: THINKING, usage });
  // At the month's web search cap, nothing was found: the usual fallbacks ask the person.
  if (!res || isSearchLimited(res)) return null;
  return readFoundLines(res.text ?? "", input.site);
}

// ---------------------------------------------------------------------------------------------
// The site's shape
// ---------------------------------------------------------------------------------------------

const Labels = z.object({
  summary: z.string().catch(""),
  sections: z.array(z.object({ path: z.string(), label: z.string(), purpose: z.string().catch("") })).catch([]),
  themes: z.array(z.object({ name: z.string(), paths: z.array(z.string()).catch([]) })).catch([]),
  notable: z.array(z.object({ label: z.string(), path: z.string(), why: z.string().catch("") })).catch([]),
  worthKnowing: z.array(z.string()).catch([]),
  newsPath: z.string().catch(""),
});

export interface SiteLabels {
  analysis: Omit<CompetitorAnalysis, "stats" | "generatedAt">;
  /** The section the model chose as the news page, when it is one we listed. */
  newsSection: string | null;
}

/** The analysis with no words from a model: sections named by their paths, nothing else. */
export function plainAnalysis(stats: CompetitorStats, now: Date): CompetitorAnalysis {
  return {
    summary: "",
    sections: stats.sections.map((s) => ({ path: s.path, label: "", purpose: "", pages: s.pages })),
    themes: [],
    notable: [],
    worthKnowing: [],
    stats,
    ai: false,
    generatedAt: now.toISOString(),
  };
}

export async function labelSite(
  input: { name: string; website: string; pages: BaselinePage[]; sections: SectionCount[]; candidates: NewsCandidate[]; usage: AiUsage },
  timeoutMs: number,
  deps: AnalyseDeps = {},
): Promise<SiteLabels | null> {
  const samples = samplePaths(input.pages, input.sections);
  const known = new Set(input.pages.map((p) => p.key));
  const sectionPaths = new Set(input.sections.map((s) => s.path));
  const isKnown = (path: string) => known.has(path) || sectionPaths.has(path) || known.has(path.replace(/\/$/, ""));
  const prompt = renderPrompt("competitors.analyse_site", {
    name: input.name,
    website: input.website,
    sections: fenced(input.sections.map((s) => `${s.path}: ${s.pages}`).join("\n")),
    samples: fenced([...samples].map(([s, keys]) => `${s}\n${keys.map((k) => `  ${k}`).join("\n")}`).join("\n")),
    news_candidates: fenced(input.candidates.map((c) => `${c.path}: ${c.pages}`).join("\n") || "(none)"),
  });
  const raw = await (deps.generate ?? generateTextWithDeadline)(prompt, { timeoutMs, json: true, thinkingBudget: THINKING, usage: input.usage });
  if (!raw) return null;
  const parsed = Labels.safeParse(parseFirstJson(raw));
  if (!parsed.success) return null;
  const l = parsed.data;
  const labelled = new Map(l.sections.filter((s) => sectionPaths.has(s.path)).map((s) => [s.path, s]));
  const newsSection = sectionPaths.has(l.newsPath) ? l.newsPath : input.candidates.some((c) => c.path === l.newsPath) ? l.newsPath : null;
  return {
    newsSection,
    analysis: {
      summary: clean(l.summary, 400),
      sections: input.sections.map((s) => ({
        path: s.path,
        pages: s.pages,
        label: clean(labelled.get(s.path)?.label ?? "", 60),
        purpose: clean(labelled.get(s.path)?.purpose ?? "", 160),
      })),
      themes: l.themes
        .map((t) => ({ name: clean(t.name, 60), paths: t.paths.filter(isKnown).slice(0, 5) }))
        .filter((t) => t.name && t.paths.length > 0)
        .slice(0, 8),
      notable: l.notable
        .filter((n) => isKnown(n.path))
        .map((n) => ({ label: clean(n.label, 60), path: n.path, why: clean(n.why, 180) }))
        .filter((n) => n.label)
        .slice(0, 8),
      worthKnowing: l.worthKnowing.map((w) => clean(w, 240)).filter(Boolean).slice(0, 3),
      ai: true,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// A week's posts, a month's changes
// ---------------------------------------------------------------------------------------------

const Summary = z.object({
  headline: z.string().catch(""),
  summary: z.string().catch(""),
  topics: z.array(z.string()).catch([]),
});

export interface ChangeWords {
  headline: string;
  summary: string;
  topics: string[];
}

function words(raw: string | null): ChangeWords | null {
  if (!raw) return null;
  const parsed = Summary.safeParse(parseFirstJson(raw));
  if (!parsed.success) return null;
  const headline = clean(parsed.data.headline, 90);
  if (!headline) return null;
  return {
    headline,
    summary: clean(parsed.data.summary, 300),
    topics: parsed.data.topics.map((t) => clean(t, 40)).filter(Boolean).slice(0, 5),
  };
}

export interface PostForSummary {
  title: string;
  description: string;
  url: string;
}

/** The headline when no model wrote one: how many, and the newest title. */
export function plainPostsHeadline(posts: PostForSummary[]): string {
  const first = posts.find((p) => p.title)?.title ?? "";
  const n = posts.length;
  const lead = `${n} new post${n === 1 ? "" : "s"}`;
  return tidy(first ? `${lead}: "${first}"${n > 1 ? " and more" : ""}` : lead, 90);
}

export async function summarisePosts(
  input: { name: string; posts: PostForSummary[]; usage: AiUsage },
  timeoutMs: number,
  deps: AnalyseDeps = {},
): Promise<ChangeWords> {
  const fallback = { headline: plainPostsHeadline(input.posts), summary: "", topics: [] };
  if (timeoutMs < 5000) return fallback;
  const prompt = renderPrompt("competitors.summarise_posts", {
    name: input.name,
    posts: fenced(input.posts.map((p) => `- ${p.title || p.url}${p.description ? `\n  ${p.description}` : ""}`).join("\n")),
  });
  return words(await (deps.generate ?? generateTextWithDeadline)(prompt, { timeoutMs, json: true, thinkingBudget: THINKING, usage: input.usage })) ?? fallback;
}

/** The headline when no model wrote one: pages added and removed, and where most were added. */
export function plainSiteHeadline(diff: Pick<SiteDiff, "added" | "removed">): string {
  const parts: string[] = [];
  if (diff.added.count) {
    const top = diff.added.sections[0];
    parts.push(`${diff.added.count} page${diff.added.count === 1 ? "" : "s"} added${top && top.section !== "/" ? ` (most under ${top.section})` : ""}`);
  }
  if (diff.removed.count) parts.push(`${diff.removed.count} removed`);
  return tidy(parts.join(", ") || "No pages added or removed", 90);
}

export async function summariseSiteChange(
  input: { name: string; website: string; before: number; after: number; diff: SiteDiff; usage: AiUsage },
  timeoutMs: number,
  deps: AnalyseDeps = {},
): Promise<ChangeWords> {
  const fallback = { headline: plainSiteHeadline(input.diff), summary: "", topics: [] };
  if (timeoutMs < 5000) return fallback;
  const list = (sections: SiteDiff["added"]["sections"]) =>
    sections.map((s) => `${s.section} (${s.count})\n${s.sample.slice(0, 15).map((k) => `  ${k}`).join("\n")}`).join("\n") || "(none)";
  const prompt = renderPrompt("competitors.summarise_site_changes", {
    name: input.name,
    website: input.website,
    before: input.before,
    after: input.after,
    appeared: fenced(input.diff.appeared.join(", ") || "(none)"),
    gone: fenced(input.diff.gone.join(", ") || "(none)"),
    added: fenced(list(input.diff.added.sections)),
    removed: fenced(list(input.diff.removed.sections)),
  });
  return words(await (deps.generate ?? generateTextWithDeadline)(prompt, { timeoutMs, json: true, thinkingBudget: THINKING, usage: input.usage })) ?? fallback;
}
