/**
 * A competitor page's title as a person would write it: HTML codes turned back into characters
 * ("Here&#x27;s" → "Here's") and the site's own name taken off the end ("AEO vs GEO | Profound" →
 * "AEO vs GEO"). Used when an article is saved and again whenever a title is shown, so titles
 * stored before this existed read right too.
 */

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
};

/** HTML character codes (named, decimal and hex) as the characters they stand for. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, code: string) => {
    if (code.startsWith("#")) {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return NAMED[code.toLowerCase()] ?? whole;
  });
}

/** What may sit between a title and the site's name after it. */
const SEPARATORS = [" | ", " – ", " — ", " - ", " · ", " :: "];

/** A name to compare: lower case, letters and digits only ("tryprofound.com" → "tryprofoundcom"). */
const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** The bare name of a site: "www.tryprofound.com" → "tryprofound". */
const siteWord = (s: string) => s.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[./]/)[0] ?? "";

/**
 * The title without its site name. A tail after " | " goes when it is short (40 characters or
 * fewer), as titles usually end; after a dash or a dot it goes only when it is one of `names` (the
 * competitor's name or its site), because a dash also starts a subtitle.
 */
export function cleanTitle(title: string, names: string[] = []): string {
  const t = decodeEntities(title ?? "").replace(/\s+/g, " ").trim();
  const known = names.flatMap((n) => [squash(n), squash(siteWord(n))]).filter((n) => n.length >= 3);
  for (const sep of SEPARATORS) {
    const at = t.lastIndexOf(sep);
    if (at <= 0) continue;
    const tail = squash(t.slice(at + sep.length));
    // "Profound" in "tryprofound", or "Peec AI" for "Peec": not a longer subtitle that merely starts with the name.
    const named = tail.length >= 3 && known.some((n) => n.includes(tail) || (tail.includes(n) && tail.length <= n.length + 4));
    if (named || (sep === " | " && t.length - at - sep.length <= 40)) return t.slice(0, at).trim();
  }
  return t;
}
