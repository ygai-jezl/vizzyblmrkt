import type { RenderSize } from "./render";

/**
 * Words for a social post's image when the person didn't write them: the post's first line,
 * cut at its first sentence, without links, hashtags, mentions or emoji, and short enough for
 * an image (about 110 characters, at a word).
 */
export function headlineFrom(postText: string, max = 110): string {
  const firstLine = postText.split(/\n+/).map((l) => l.trim()).find(Boolean) ?? "";
  const clean = firstLine
    .replace(/https?:\/\/\S+/g, "")
    .replace(/(^|\s)[#@][\w-]+/g, "$1")
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(clean)?.[1] ?? clean;
  if (sentence.length <= max) return sentence;
  return `${sentence.slice(0, max).replace(/\s+\S*$/, "")}…`;
}

/** The render size for each social aspect (1.91:1 is LinkedIn's and X's link-card shape). */
export const SOCIAL_RENDER_SIZE: Record<"1:1" | "4:5" | "1.91:1", RenderSize> = {
  "1:1": "square",
  "4:5": "portrait",
  "1.91:1": "landscape",
};
