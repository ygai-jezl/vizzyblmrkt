import type { ProposalKind, ReviewEvidence, ReviewStep } from "@/lib/types/articleRefresh";

/**
 * How a refresh review's steps, changes and evidence are said (BLOG_REFRESH_ENABLED): the same
 * words on the article and to Vizzy. Pure and safe in the browser.
 */

export const STEP_SAID: Record<ReviewStep, string> = {
  read: "reading the article",
  sources: "opening its sources",
  research: "looking for newer research",
  brand: "reading your brand map, product facts and Search Console",
  propose: "writing up what to change",
};

export const KIND_SAID: Record<ProposalKind, string> = {
  newer_figure: "Newer figure",
  answer_search: "A search that lands here",
  new_question: "A question asked now",
  product_fact: "Your product changed",
  note: "Your team's note",
  dead_source: "Dead link · keeps the date",
  source_link: "Moved link · keeps the date",
};

const host = (url: string | null) => {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
};

/** One line of evidence, in words a person checks it by. */
export function evidenceLine(e: ReviewEvidence): string {
  switch (e.kind) {
    case "new_fact":
      return `${e.detail.split(",")[0] || host(e.url)}${e.year ? `, ${e.year}` : ""}: "${e.text}"`;
    case "page_search":
      return `Search Console: "${e.text}", ${e.detail}`;
    case "dead_link":
      return `${host(e.url)} no longer opens`;
    case "source_moved":
      return `${host(e.url)}: ${e.detail}`;
    case "source_changed":
      return e.detail;
    case "product_fact":
      return `Your material${e.detail ? `, ${e.detail}` : ""}`;
    case "note":
      return "What we've seen";
    default:
      return `"${e.text}", ${e.detail}`;
  }
}

