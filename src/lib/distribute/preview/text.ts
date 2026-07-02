/**
 * Shared text helpers for platform-native previews. Pure + client-safe.
 */

/** A "…see more"-style truncation result. */
export interface Truncation {
  visible: string;
  truncated: boolean;
}

/**
 * Approximate a platform's visible length by Unicode code points. (X actually
 * uses a weighted count — URLs count as 23, some CJK as 2 — so this is a preview
 * approximation, good enough for a length/threshold indicator.)
 */
export function cpLength(s: string): number {
  return [...s].length;
}

/** Cut to `limit` code points, preferring the last word boundary near the limit. */
export function cutAtWord(text: string, limit: number): string {
  const cp = [...text];
  if (cp.length <= limit) return text;
  let cut = cp.slice(0, limit).join("");
  const lastSpace = cut.lastIndexOf(" ");
  // Only honour a word boundary if it isn't so early it drops most of the text.
  if (lastSpace > limit * 0.6) cut = cut.slice(0, lastSpace);
  return cut.trimEnd();
}
