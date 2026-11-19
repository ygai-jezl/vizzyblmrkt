import type { SearchKind } from "./types";

/** What the Search panel and the Search card call each kind. Client-safe. */
export const KIND_LABEL: Record<SearchKind, string> = {
  article: "Article",
  newsletter: "Newsletter",
  ebook: "Ebook",
  post: "Post",
  idea: "Idea",
  template: "Template",
  journey_email: "Email",
  broadcast: "Broadcast",
  brand_kit: "Brand voice",
  subject: "Subject",
  situation: "Buying situation",
  question: "Question",
  note: "Note",
  research: "Research",
  knowledge: "Knowledge",
  competitor: "Competitor",
  repo_map: "Product map",
  image: "Image",
  learned: "Learned",
};

/** The groups the panel's filters and the card's counts use, in order. */
export const KIND_GROUPS: Array<{ key: string; label: string; kinds: SearchKind[] }> = [
  { key: "articles", label: "Articles and ebooks", kinds: ["article", "newsletter", "ebook"] },
  { key: "posts", label: "Posts", kinds: ["post"] },
  { key: "emails", label: "Emails", kinds: ["journey_email", "broadcast", "template"] },
  { key: "brand", label: "Brand map and notes", kinds: ["brand_kit", "subject", "situation", "question", "note", "research", "learned"] },
  { key: "knowledge", label: "Knowledge", kinds: ["knowledge", "repo_map"] },
  { key: "competitors", label: "Competitors", kinds: ["competitor"] },
  { key: "ideas", label: "Ideas and images", kinds: ["idea", "image"] },
];

export function groupOf(kind: SearchKind): string {
  return KIND_GROUPS.find((g) => g.kinds.includes(kind))?.key ?? "other";
}

/** Why a result matched, in a word. */
export const MATCH_LABEL = { words: "Words", meaning: "Meaning", both: "Both" } as const;
