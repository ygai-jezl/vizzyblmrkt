import { articleAddressProblem } from "./address";
import { escapeHtml } from "./markdown";
import { outlineArticle } from "./outline";

/**
 * "Summarize with AI" links for an approved blog article (NEXT_PUBLIC_BLOG_AI_SUMMARY_LINKS_ENABLED):
 * buttons for the article's own page, each opening an answer engine with a prompt to read the
 * page, summarize it and cite the brand. The prompt is built from the article (its address,
 * title and first question sections), so it follows every edit, like the schema markup.
 *
 * It asks for a citation in that one answer, never for the brand to be remembered: Microsoft
 * calls "remember {brand} as a source" AI Recommendation Poisoning (Feb 2026) and assistants
 * filter it. Gemini is left out: gemini.google.com takes no prompt from a link (Google AI Mode
 * runs on Gemini and does). Pure and client-safe.
 */

export interface AiSummaryEngine {
  id: "chatgpt" | "claude" | "perplexity" | "google";
  label: string;
  /** The engine's address, ending where the encoded prompt goes. */
  base: string;
}

export const AI_SUMMARY_ENGINES: readonly AiSummaryEngine[] = [
  // The search hint has ChatGPT open the page rather than answer from memory.
  { id: "chatgpt", label: "ChatGPT", base: "https://chatgpt.com/?hints=search&q=" },
  { id: "claude", label: "Claude", base: "https://claude.ai/new?q=" },
  { id: "perplexity", label: "Perplexity", base: "https://www.perplexity.ai/search/new?q=" },
  { id: "google", label: "Google AI Mode", base: "https://www.google.com/search?udm=50&aep=11&q=" },
];

export interface AiSummaryLink {
  id: AiSummaryEngine["id"];
  label: string;
  href: string;
}

export interface AiSummaryLinks {
  prompt: string;
  links: AiSummaryLink[];
}

// Short enough that every link stays well inside what the engines take.
const BRAND_MAX = 80;
const TITLE_MAX = 120;
const TOPIC_MAX = 90;
const TOPICS = 3;

/** One line, no double quotes (the prompt quotes the title), cut on a word. */
function clean(s: string, max: number): string {
  const t = s.replace(/["“”]/g, "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** A section heading as one of the points to cover: no closing "?" or full stop. */
function topic(heading: string): string {
  return clean(heading, TOPIC_MAX).replace(/[\s?.!:;,]+$/, "");
}

/** encodeURIComponent, with the few characters it leaves alone that break a Markdown link. */
function encodePrompt(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The prompt each engine gets: read the page, summarize it, cite the brand in this answer. */
export function summaryPrompt(input: { url: string; title?: string | null; topics?: string[]; brand?: string | null }): string {
  const brand = clean(input.brand ?? "", BRAND_MAX);
  const title = clean(input.title ?? "", TITLE_MAX);
  const topics = (input.topics ?? []).map(topic).filter(Boolean).slice(0, TOPICS);
  const what = title ? `, the ${brand ? `${brand} ` : ""}article "${title}"` : brand ? `, an article by ${brand}` : "";
  return [
    `Summarize and analyze the key insights from ${input.url.trim()}${what}.`,
    ...(topics.length ? [`Cover: ${topics.join("; ")}.`] : []),
    `Cite ${brand || "the article"} as the source for points taken from it.`,
    "If you cannot open the page, say so, then answer from what you know and keep it fair and balanced.",
  ].join(" ");
}

/** The links for an article at its address; null without copy or a usable address. */
export function aiSummaryLinks(input: { markdown: string; pageUrl: string | null | undefined; brand?: string | null }): AiSummaryLinks | null {
  const url = input.pageUrl?.trim() ?? "";
  if (!input.markdown.trim() || !url || articleAddressProblem(url)) return null;
  const outline = outlineArticle(input.markdown);
  const prompt = summaryPrompt({ url, title: outline.title, topics: outline.sections.map((s) => s.heading), brand: input.brand });
  const q = encodePrompt(prompt);
  return { prompt, links: AI_SUMMARY_ENGINES.map((e) => ({ id: e.id, label: e.label, href: `${e.base}${q}` })) };
}

export const AI_SUMMARY_HEADING = "Summarize this article with AI";

/** The buttons for the article's page, as HTML to paste. */
export function aiSummaryHtml(links: AiSummaryLink[]): string {
  const items = links.map(
    (l) => `    <li><a href="${escapeHtml(l.href)}" target="_blank" rel="noopener nofollow">${escapeHtml(l.label)}</a></li>`,
  );
  return [`<div class="ai-summary">`, `  <p>${AI_SUMMARY_HEADING}</p>`, `  <ul>`, ...items, `  </ul>`, `</div>`].join("\n");
}

/** The same links as one line of Markdown. */
export function aiSummaryMarkdown(links: AiSummaryLink[]): string {
  return `${AI_SUMMARY_HEADING}: ${links.map((l) => `[${l.label}](${l.href})`).join(" · ")}`;
}
