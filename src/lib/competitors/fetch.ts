import { constants, gunzipSync } from "node:zlib";
import { platformOrigin } from "@/lib/platform/origin";
import { readBytesUpTo, safeFetch } from "@/lib/security/ssrf";
import { allowedFor } from "@/lib/content/blog/crawlers";
import { COMPETITOR_LIMITS } from "@/lib/types/competitor";

/**
 * Everything Competitors fetches from someone else's site goes through here: https only, the
 * connect-time private address check and capped redirects (safeFetch), capped bodies, and one
 * polite client name. Never throws: a failure is a value the caller turns into words.
 */

/** The product token robots.txt groups can name us by. */
export const ROBOTS_TOKEN = "yougrowbot";

/** A neutral client name with this instance's own address, so a site owner can reach whoever runs it. */
export function userAgent(): string {
  const origin = platformOrigin();
  return `YouGrowBot/1.0 (competitor monitor${origin ? `; +${origin}` : ""})`;
}

export type Fetcher = typeof safeFetch;

export interface FetchDeps {
  fetch?: Fetcher;
}

export type Fetched =
  | { ok: true; url: string; text: string; truncated: boolean; contentType: string }
  | { ok: false; reason: "not_found" | "refused" | "failed" };

const HTML_BYTES = 1_000_000;

async function fetchBytes(
  url: string,
  accept: string,
  maxBytes: number,
  deps: FetchDeps,
  timeoutMs = 8000,
): Promise<{ ok: true; url: string; bytes: Buffer; truncated: boolean; contentType: string } | { ok: false; reason: "not_found" | "refused" | "failed" }> {
  try {
    const res = await (deps.fetch ?? safeFetch)(url, { headers: { "User-Agent": userAgent(), Accept: accept } }, { timeoutMs, maxRedirects: 3 });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 404 || res.status === 410) return { ok: false, reason: "not_found" };
      if ([401, 403, 429, 451].includes(res.status)) return { ok: false, reason: "refused" };
      return { ok: false, reason: "failed" };
    }
    const { bytes, truncated } = await readBytesUpTo(res, maxBytes);
    return { ok: true, url: res.url || url, bytes, truncated, contentType: res.headers.get("content-type") ?? "" };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

/** Gzip starts with these two bytes, whatever the server calls it. */
function isGzip(b: Buffer): boolean {
  return b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
}

/**
 * One sitemap file as text: plain or gzipped (a `.xml.gz` arrives as raw gzip), cut at
 * MAX_SITEMAP_BYTES after unzipping. A cut file says so, so it never reads as a smaller site.
 */
export async function fetchSitemapFile(url: string, deps: FetchDeps = {}): Promise<Fetched> {
  const max = COMPETITOR_LIMITS.MAX_SITEMAP_BYTES;
  const got = await fetchBytes(url, "application/xml,text/xml,text/plain;q=0.8,*/*;q=0.5", max, deps, 10_000);
  if (!got.ok) return got;
  let bytes = got.bytes;
  const truncated = got.truncated;
  if (isGzip(bytes)) {
    try {
      // Sync flush: a gzip cut by the byte cap still yields what it holds.
      bytes = gunzipSync(bytes, { finishFlush: constants.Z_SYNC_FLUSH, maxOutputLength: max });
    } catch {
      // Bigger than the cap once unzipped (or not gzip after all): nothing we can trust.
      return { ok: true, url: got.url, text: "", truncated: true, contentType: got.contentType };
    }
  }
  return { ok: true, url: got.url, text: bytes.toString("utf8"), truncated, contentType: got.contentType };
}

/** A page of HTML (a news page or a post), capped. Anything that isn't HTML is a failure. */
export async function fetchHtml(url: string, deps: FetchDeps = {}): Promise<Fetched> {
  const got = await fetchBytes(url, "text/html,application/xhtml+xml", HTML_BYTES, deps);
  if (!got.ok) return got;
  if (!/text\/html|application\/xhtml/i.test(got.contentType)) return { ok: false, reason: "failed" };
  return { ok: true, url: got.url, text: got.bytes.toString("utf8"), truncated: got.truncated, contentType: got.contentType };
}

/** A feed (RSS or Atom), capped. */
export async function fetchFeed(url: string, deps: FetchDeps = {}): Promise<Fetched> {
  const got = await fetchBytes(url, "application/rss+xml,application/atom+xml,application/xml,text/xml", HTML_BYTES, deps);
  if (!got.ok) return got;
  return { ok: true, url: got.url, text: got.bytes.toString("utf8"), truncated: got.truncated, contentType: got.contentType };
}

const ROBOTS_BYTES = 200_000;

/**
 * The site's robots.txt, read once per check. No file (or a page of HTML where it should be) means
 * no rules. A site we couldn't ask (an error, a refusal) is read as "keep out": we only read pages
 * a site has said we may.
 */
export async function robotsFor(origin: string, deps: FetchDeps = {}): Promise<{ text: string; reachable: boolean; origin: string }> {
  const got = await fetchBytes(`${origin}/robots.txt`, "text/plain", ROBOTS_BYTES, deps, 5000);
  if (!got.ok) return got.reason === "not_found" ? { text: "", reachable: true, origin } : { text: "", reachable: false, origin };
  // Where the site answered from, after redirects ("acme.example" → "https://www.acme.example").
  let answered = origin;
  try {
    answered = new URL(got.url).origin;
  } catch {
    /* keep the one asked */
  }
  const text = got.bytes.toString("utf8");
  return { text: /^\s*<(!doctype|html)\b/i.test(text) ? "" : text, reachable: true, origin: answered };
}

/** May we read this URL, given the robots.txt of its origin? */
export function mayFetch(robots: { text: string; reachable: boolean }, url: string): boolean {
  if (!robots.reachable) return false;
  try {
    const u = new URL(url);
    return allowedFor(robots.text, ROBOTS_TOKEN, `${u.pathname}${u.search}`);
  } catch {
    return false;
  }
}
