import { cpLength, cutAtWord, type Truncation } from "./text";

/**
 * LinkedIn preview logic: the feed truncates a post before "…see more" at roughly
 * 3 lines or ~210 characters (whichever comes first). Pure; an approximation of
 * the native desktop cutoff.
 */

export const LINKEDIN_SEE_MORE_CHARS = 210;
export const LINKEDIN_SEE_MORE_LINES = 3;

export function truncateSeeMore(
  body: string,
  opts: { charLimit?: number; lineLimit?: number } = {},
): Truncation {
  const charLimit = opts.charLimit ?? LINKEDIN_SEE_MORE_CHARS;
  const lineLimit = opts.lineLimit ?? LINKEDIN_SEE_MORE_LINES;
  const text = body.replace(/\r\n/g, "\n");

  // Line cutoff first — LinkedIn collapses to the first few lines.
  const lines = text.split("\n");
  let visible = text;
  let truncated = false;
  if (lines.length > lineLimit) {
    visible = lines.slice(0, lineLimit).join("\n");
    truncated = true;
  }

  // Then the character cutoff on what remains.
  if (cpLength(visible) > charLimit) {
    visible = cutAtWord(visible, charLimit);
    truncated = true;
  }

  return { visible: visible.trimEnd(), truncated };
}
