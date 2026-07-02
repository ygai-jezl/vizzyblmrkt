import { cpLength } from "./text";

/**
 * X (Twitter) preview logic: single-tweet length + long-copy thread splitting.
 * Pure. This is the canonical splitter the Phase-2 Thread Deconstructor builds on.
 */

export const X_MAX_CHARS = 280;

/** Approximate visible tweet length (code points; see text.ts on the approximation). */
export function tweetLength(text: string): number {
  return cpLength(text);
}

/**
 * Split long copy into a thread of parts each ≤ `limit`. Greedy word packing that
 * PRESERVES internal whitespace (incl. line breaks) within a part; an over-long
 * single word (e.g. a URL) is hard-split by code point. Returns [] for empty input
 * and [text] when it already fits.
 */
export function splitIntoTweets(body: string, limit = X_MAX_CHARS): string[] {
  // Defensive: a computed/config limit (e.g. the Phase-2 Deconstructor reserving
  // space for a suffix) must never be 0, negative, or fractional — that would hang
  // or garbage the hard-split below.
  const max = Math.max(1, Math.floor(limit));
  const text = body.replace(/\r\n/g, "\n").trim();
  if (!text) return [];
  if (tweetLength(text) <= max) return [text];

  const tweets: string[] = [];
  // Keep whitespace tokens so the original spacing/line-breaks survive within a part.
  const tokens = text.split(/(\s+)/);
  let current = "";
  const flush = () => {
    const t = current.trim();
    if (t) tweets.push(t);
    current = "";
  };

  for (const tok of tokens) {
    if (!tok) continue;
    if (tweetLength(current + tok) <= max) {
      current += tok;
      continue;
    }
    flush();
    if (/^\s+$/.test(tok)) continue; // don't start a part with whitespace
    if (tweetLength(tok) > max) {
      // Hard-split an over-long single token (long URL, emoji/hashtag wall) by
      // GRAPHEME cluster so a ZWJ/flag/skin-tone sequence is never severed. Keep
      // the final chunk open so following words can still pack onto it.
      const chunks = hardSplitToken(tok, max);
      for (let i = 0; i < chunks.length - 1; i += 1) tweets.push(chunks[i]!);
      current = chunks[chunks.length - 1] ?? "";
    } else {
      current = tok;
    }
  }
  flush();
  return tweets;
}

type GraphemeSegmenter = { segment(input: string): Iterable<{ segment: string }> };

/** Grapheme clusters (never severs ZWJ/flag/skin-tone sequences); code points as fallback. */
function graphemes(s: string): string[] {
  const Ctor = (
    Intl as unknown as {
      Segmenter?: new (l?: string, o?: { granularity: "grapheme" }) => GraphemeSegmenter;
    }
  ).Segmenter;
  if (Ctor) {
    return Array.from(new Ctor(undefined, { granularity: "grapheme" }).segment(s), (x) => x.segment);
  }
  return [...s];
}

/**
 * Split an over-long token into parts of ≤`limit` code points on grapheme
 * boundaries. Always emits ≥1 grapheme per part, so it terminates even when a
 * single grapheme exceeds the limit (that lone cluster is kept whole, not severed).
 */
function hardSplitToken(token: string, limit: number): string[] {
  const parts: string[] = [];
  let cur = "";
  let curLen = 0;
  for (const g of graphemes(token)) {
    const gl = cpLength(g);
    if (cur && curLen + gl > limit) {
      parts.push(cur);
      cur = "";
      curLen = 0;
    }
    cur += g;
    curLen += gl;
  }
  if (cur) parts.push(cur);
  return parts;
}

/** Whether the copy fits in a single tweet. */
export function isSingleTweet(body: string, limit = X_MAX_CHARS): boolean {
  return tweetLength(body.trim()) <= limit;
}
