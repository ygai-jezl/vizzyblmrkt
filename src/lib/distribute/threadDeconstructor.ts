import { splitIntoTweets, tweetLength, X_MAX_CHARS } from "./preview/x";

/**
 * X Thread Deconstructor: turn a long-form hub body (newsletter/blog) into an
 * ordered, sequential X thread. Splits at sub-headers (each markdown `#`-section
 * becomes its own part, further split if it exceeds the tweet limit); with no
 * headers it packs paragraphs greedily. Pure; the canonical `threadParts` builder
 * (the raw parts — numbering is a display concern, see XPreview).
 */

/** Strip leading markdown header markers from a line (## Foo → Foo). */
function stripHeaderMarker(line: string): string {
  return line.replace(/^#{1,6}\s+/, "");
}

/** Split into header-delimited sections: a header line starts a new section. */
function splitIntoSections(text: string): string[] {
  const sections: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    const s = buf.join("\n").trim();
    if (s) sections.push(s);
    buf = [];
  };
  for (const line of text.split("\n")) {
    if (/^#{1,6}\s+/.test(line)) {
      flush();
      buf.push(stripHeaderMarker(line));
    } else {
      buf.push(line);
    }
  }
  flush();
  return sections;
}

/** Pack paragraphs (blank-line separated) greedily into ≤limit parts. */
function packParagraphs(text: string, limit: number): string[] {
  const paras = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const parts: string[] = [];
  let current = "";
  for (const para of paras) {
    if (tweetLength(para) > limit) {
      if (current) {
        parts.push(current);
        current = "";
      }
      for (const t of splitIntoTweets(para, limit)) parts.push(t);
      continue;
    }
    const candidate = current ? `${current}\n\n${para}` : para;
    if (tweetLength(candidate) <= limit) {
      current = candidate;
    } else {
      if (current) parts.push(current);
      current = para;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * Deconstruct `body` into an ordered X thread. Returns [] for empty input and a
 * single-element array when the copy already fits one tweet. Every returned part
 * is ≤ `limit` (grapheme-safe, via splitIntoTweets).
 */
export function deconstructToThread(body: string, limit = X_MAX_CHARS): string[] {
  const text = body.replace(/\r\n/g, "\n").trim();
  if (!text) return [];
  const hasHeaders = /^#{1,6}\s+/m.test(text);
  // Fast path ONLY when there are no header markers to strip — otherwise a short
  // single-header hub would leak the raw "## " into the tweet.
  if (!hasHeaders && tweetLength(text) <= limit) return [text];

  // Header path strips markers per section; both paths bottom out in the
  // grapheme-safe splitIntoTweets and yield ≥1 part for any non-empty text.
  return hasHeaders
    ? splitIntoSections(text).flatMap((section) => splitIntoTweets(section, limit))
    : packParagraphs(text, limit);
}
