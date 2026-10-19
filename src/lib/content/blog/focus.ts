import type { BlogBrief, BlogLink } from "@/lib/types/contentPlan";
import { hostOf } from "./brief";

/**
 * What keeps an editorial article on its question, decided by code rather than asked of the
 * writer: a brief researched before the editorial writer (or by hand) can still hold questions
 * about alternatives, a definition of the subject, and alternative companies to name. The writer
 * is never handed those unless the article's question is about choosing a product, and a page's
 * slogan never reaches it as a page's name. Pure + client-safe.
 */

/** A question about choosing a product: only then do alternatives belong in the article. */
const CHOOSING = /\b(best|top|alternatives?|vs\.?|versus|compare|comparison|choose|choosing|which (?:tool|platform|software|app|vendor)s?)\b/i;

export function isChoosingQuestion(question: string): boolean {
  return CHOOSING.test(question);
}

/**
 * The brief as the editorial writer is given it. Research's own questions about alternatives and
 * definitions, and its alternative companies, are left out unless the question is about choosing.
 * A person's own rows are theirs and stay.
 */
export function focusedBrief(brief: BlogBrief, question: string): BlogBrief {
  if (isChoosingQuestion(question)) return brief;
  return {
    ...brief,
    questions: brief.questions.filter((q) => q.by !== "research" || (q.intent !== "alternatives" && q.intent !== "definition")),
    entities: brief.entities.filter((e) => e.by !== "research" || e.relation !== "alternative"),
  };
}

/** A label that reads as a slogan or a sentence (a page's marketing title), not a page's name. */
export function isSloganLabel(label: string): boolean {
  const t = label.trim();
  return /[.!?]\s*\S/.test(t) || /[.!?]$/.test(t) || t.split(/\s+/).length > 6;
}

/** A plain name for a page, from its address ("https://acme.example/waitlist" → "Waitlist page"). */
export function pageNameFromUrl(url: string): string {
  let path = "";
  try {
    path = new URL(url).pathname;
  } catch {
    return hostOf(url) || "Page";
  }
  const last = path.split("/").filter(Boolean).pop();
  if (!last) return `${hostOf(url)} home page`;
  const words = decodeURIComponent(last).replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim();
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)} page` : "Page";
}

/** The brief's pages as the editorial writer sees them: a slogan label becomes the page's plain name. */
export function writerLinks(links: BlogLink[]): BlogLink[] {
  return links.map((l) => (isSloganLabel(l.label) ? { ...l, label: pageNameFromUrl(l.url) } : l));
}
