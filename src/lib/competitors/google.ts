import { readUrlsWithGoogle, type AiUsage, type UrlReadResult } from "@/lib/agents/gemini";
import { renderPrompt } from "@/lib/agents/prompts/registry";
import { normalizeUrl } from "@/lib/content/blog/brief";
import { asHttps, onSite } from "./sitemap";
import { cleanTitle } from "./titles";

/**
 * Reading a site that turns automated readers like ours away, through Google instead: Gemini's
 * URL context tool reads the file from Google's side (its index first, then live, obeying
 * robots.txt) and copies it back. A model is copying, so nothing is taken on trust:
 *
 * - an answer counts only when Google says it read that address;
 * - addresses come only from sitemap files, never from a web page (asked to list the links on a
 *   blog page, the model made up 99 of 101 from the titles; asked to copy a sitemap, it copied
 *   every one exactly);
 * - every address must be on the competitor's own site, and a post's title is kept only for an
 *   address we asked about.
 */

export type ReadWithGoogle = (prompt: string, opts: { timeoutMs: number; thinkingBudget?: number; usage: AiUsage }) => Promise<UrlReadResult | null>;

export interface GoogleDeps {
  readWithGoogle?: ReadWithGoogle;
}

const SUCCESS = "URL_RETRIEVAL_STATUS_SUCCESS";
/** Copying needs no thinking, and it keeps a call inside a step's time. */
const THINKING = 0;
/** How much of their robots.txt we keep while finding their news (rules past this are rare). */
export const ROBOTS_KEEP = 20_000;
/**
 * Lines asked of one sitemap file while finding: its newest posts are the baseline. Copying is
 * slow (300 lines of a 160 KB file ran past a step's 15 seconds), so it asks for few.
 */
export const GOOGLE_SITEMAP_MAX = 60;
export const GOOGLE_POSTS_MAX = 10;

export function readerOf(deps: GoogleDeps): ReadWithGoogle {
  return deps.readWithGoogle ?? readUrlsWithGoogle;
}

/** The same address, give or take a scheme, a trailing slash or a "www.". */
function sameAddress(a: string, b: string): boolean {
  const key = (raw: string) => {
    try {
      const u = new URL(raw);
      return `${u.hostname.toLowerCase().replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}${u.search}`;
    } catch {
      return raw;
    }
  };
  return key(a) === key(b);
}

/** Google says it read this address. One address asked and one read counts too: the tool may name it after a redirect. */
export function wasRead(res: UrlReadResult, url: string): boolean {
  const ok = res.retrieved.filter((r) => r.status === SUCCESS);
  if (ok.some((r) => sameAddress(r.url, url))) return true;
  return res.retrieved.length === 1 && ok.length === 1;
}

/** The answer's lines, without code fences or blank lines. */
function linesOf(text: string): string[] {
  return text
    .replace(/^```[a-z]*\s*$/gim, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

const CANNOT = /^CANNOT_READ\b/;

/** Their robots.txt as Google read it, or null when Google couldn't read it. */
export async function googleReadRobots(url: string, timeoutMs: number, usage: AiUsage, deps: GoogleDeps = {}): Promise<string | null> {
  const res = await readerOf(deps)(renderPrompt("competitors.read_robots", { url }), { timeoutMs, thinkingBudget: THINKING, usage });
  if (!res || !wasRead(res, url)) return null;
  const text = linesOf(res.text).join("\n");
  if (!text || CANNOT.test(text) || /^<(!doctype|html)\b/i.test(text)) return null;
  return text.slice(0, ROBOTS_KEEP);
}

export interface GoogleSitemap {
  kind: "index" | "urlset";
  entries: Array<{ loc: string; lastmod: string | null }>;
}

/**
 * A sitemap file's entries as Google read them, newest first, at most `max`. Each line must be an
 * address on their site, with a date or nothing after it; anything else is dropped.
 * "no_answer": the call itself failed or ran out of time (worth asking again). Null: Google couldn't
 * read the file, or nothing usable came back.
 */
export async function googleReadSitemap(
  url: string,
  opts: { site: string; max: number; usage: AiUsage },
  timeoutMs: number,
  deps: GoogleDeps = {},
): Promise<GoogleSitemap | "no_answer" | null> {
  const res = await readerOf(deps)(renderPrompt("competitors.read_sitemap", { url, max: opts.max }), { timeoutMs, thinkingBudget: THINKING, usage: opts.usage });
  if (!res) return "no_answer";
  if (!wasRead(res, url)) return null;
  const lines = linesOf(res.text);
  if (!lines.length || CANNOT.test(lines[0]!)) return null;
  let kind: GoogleSitemap["kind"] | null = null;
  const entries: GoogleSitemap["entries"] = [];
  const seen = new Set<string>();
  for (const l of lines) {
    const k = /^KIND:\s*(index|urlset)\b/i.exec(l);
    if (k) {
      kind = k[1]!.toLowerCase() as GoogleSitemap["kind"];
      continue;
    }
    const [rawLoc = "", rawMod, ...rest] = l.split(/\s+/);
    if (rest.length || !/^https?:\/\//i.test(rawLoc)) continue;
    const loc = asHttps(rawLoc);
    if (!onSite(loc, opts.site)) continue;
    let lastmod: string | null = null;
    if (rawMod) {
      if (Number.isNaN(Date.parse(rawMod))) continue;
      lastmod = rawMod;
    }
    if (seen.has(loc)) continue;
    seen.add(loc);
    entries.push({ loc, lastmod });
    if (entries.length >= opts.max) break;
  }
  if (!entries.length) return null;
  return { kind: kind ?? (entries.every((e) => /\.xml(\.gz)?(\?|$)/i.test(e.loc)) ? "index" : "urlset"), entries };
}

export interface GooglePost {
  title: string;
  publishedAt: string | null;
}

/**
 * The titles and dates of posts, as Google read them: up to GOOGLE_POSTS_MAX addresses in one
 * call. Keyed by the address we asked about; a line naming any other address is dropped, and so is
 * a page Google says it couldn't read.
 */
export async function googleReadPosts(urls: string[], timeoutMs: number, usage: AiUsage, deps: GoogleDeps = {}): Promise<Map<string, GooglePost>> {
  const out = new Map<string, GooglePost>();
  const asked = urls.slice(0, GOOGLE_POSTS_MAX);
  if (!asked.length) return out;
  const res = await readerOf(deps)(renderPrompt("competitors.read_posts", { urls: asked.join("\n") }), { timeoutMs, thinkingBudget: THINKING, usage });
  if (!res) return out;
  for (const l of linesOf(res.text)) {
    const [rawUrl = "", rawTitle = "", rawDate = ""] = l.split("\t").map((p) => p.trim());
    const url = asked.find((u) => sameAddress(u, rawUrl));
    if (!url || out.has(url) || !rawTitle) continue;
    if (!res.retrieved.some((r) => r.status === SUCCESS && sameAddress(r.url, url))) continue;
    const day = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) && !Number.isNaN(Date.parse(rawDate)) ? rawDate : null;
    out.set(url, { title: withoutSiteName(rawTitle).slice(0, 200), publishedAt: day });
  }
  return out;
}

/** "Whitening myths | Acme Dental" → "Whitening myths": a page title's short site name after a bar goes. */
export function withoutSiteName(title: string): string {
  return cleanTitle(title);
}

/** A title from the address alone, for a post Google couldn't read: "/blog/opening-hours/" → "Opening hours". */
export function titleFromSlug(url: string): string {
  try {
    const slug = new URL(normalizeUrl(url) || url).pathname.split("/").filter(Boolean).at(-1) ?? "";
    const words = decodeURIComponent(slug).replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[-_+]+/g, " ").trim();
    return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}`.slice(0, 200) : "";
  } catch {
    return "";
  }
}
