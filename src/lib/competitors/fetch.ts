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

/**
 * Why a fetch failed. "turned_away": the site answered, but not to us: a refusal (401, 403, 429,
 * 451) or a bot screen's challenge page where the file or page should be. Their bot screen, not
 * their robots.txt: robots rules are read and obeyed separately (mayFetch).
 */
export type FetchFailure = "not_found" | "turned_away" | "failed";

export type Fetched =
  | { ok: true; url: string; text: string; truncated: boolean; contentType: string }
  | { ok: false; reason: FetchFailure };

const HTML_BYTES = 1_000_000;
/** How much of an HTML answer is searched for a bot screen's challenge. */
const CHALLENGE_BYTES = 8192;

/**
 * Signs of a bot screen's challenge page rather than the site itself. STRONG ones appear only on a
 * challenge (SiteGround's captcha address, Cloudflare's "Just a moment..." page and its challenge
 * options, Vercel's checkpoint). WEAK ones are also put into ordinary pages by the same screens
 * (Cloudflare's detection script, Imperva's resource, AWS WAF's and DataDome's scripts), so they
 * count only on a refusal or a small page: a challenge is a few KB, a real news page far more.
 */
const STRONG = [
  /\/\.well-known\/sgcaptcha/i,
  /<title>\s*Just a moment\.\.\.\s*<\/title>/i,
  /\b_?cf_chl_opt\b/i,
  /Vercel Security Checkpoint/i,
];
const WEAK = [/\/cdn-cgi\/challenge-platform/i, /_Incapsula_Resource/i, /\bAwsWafIntegration\b|\baws-waf-token\b/i, /captcha-delivery\.com/i];
/** A page this small with a WEAK sign is taken as a challenge. */
const SMALL_PAGE = 32_768;

/** A challenge page, from its address (where a redirect landed) or its first bytes. */
export function isChallenge(url: string, head: string, opts: { refused?: boolean; bytes?: number } = {}): boolean {
  if (/\/\.well-known\/sgcaptcha/i.test(url)) return true;
  if (STRONG.some((re) => re.test(head))) return true;
  const small = opts.refused || (opts.bytes !== undefined && opts.bytes < SMALL_PAGE);
  return Boolean(small) && WEAK.some((re) => re.test(head));
}

/**
 * Say why a fetch failed, by host only: never the path (it can name a person) or anything the
 * site sent. A file that simply isn't there (404, 410) is normal while finding, so isn't logged.
 */
function logFailure(url: string, what: string): void {
  let host = "?";
  try {
    host = new URL(url).hostname;
  } catch {
    /* keep "?" */
  }
  console.warn(`[competitors] fetch ${host} answered ${what}`);
}

/** An error's message when it is a plain code ("host_blocked", "timeout"), else "error": never a URL. */
function errorCode(err: unknown): string {
  const m = err instanceof Error ? err.message : "";
  return /^[a-z_]{2,40}$/i.test(m) ? m : err instanceof Error && err.name === "TimeoutError" ? "timeout" : "error";
}

async function fetchBytes(
  url: string,
  accept: string,
  maxBytes: number,
  deps: FetchDeps,
  timeoutMs = 8000,
): Promise<{ ok: true; url: string; bytes: Buffer; truncated: boolean; contentType: string } | { ok: false; reason: FetchFailure }> {
  try {
    const res = await (deps.fetch ?? safeFetch)(url, { headers: { "User-Agent": userAgent(), Accept: accept } }, { timeoutMs, maxRedirects: 3 });
    const at = res.url || url;
    const contentType = res.headers.get("content-type") ?? "";
    const html = /text\/html|application\/xhtml/i.test(contentType);
    if (!res.ok) {
      if (res.status === 404 || res.status === 410) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: false, reason: "not_found" };
      }
      // A 503 may be a bot screen too: look at the start of the page it sent.
      const head = html ? (await readBytesUpTo(res, CHALLENGE_BYTES)).bytes.toString("latin1") : "";
      if (!html) await res.body?.cancel().catch(() => undefined);
      const turned = [401, 403, 429, 451].includes(res.status) || isChallenge(at, head, { refused: true });
      logFailure(url, `${res.status}${turned ? " (turned away)" : ""}`);
      return { ok: false, reason: turned ? "turned_away" : "failed" };
    }
    const { bytes, truncated } = await readBytesUpTo(res, maxBytes);
    const looksHtml = html || /^\s*<(!doctype|html|head|body|meta|script)\b/i.test(bytes.subarray(0, 256).toString("latin1"));
    if (looksHtml && isChallenge(at, bytes.subarray(0, CHALLENGE_BYTES).toString("latin1"), { bytes: truncated ? Infinity : bytes.length })) {
      logFailure(url, `${res.status} with a challenge page (turned away)`);
      return { ok: false, reason: "turned_away" };
    }
    return { ok: true, url: at, bytes, truncated, contentType };
  } catch (err) {
    logFailure(url, errorCode(err));
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
export interface Robots {
  text: string;
  reachable: boolean;
  /** The origin it answered from, after redirects. */
  origin: string;
  /** The site turned us away (a refusal or a bot screen's challenge). */
  turnedAway: boolean;
  /** A web page came back where robots.txt should be (no rules, and a sign of a screen or a site that answers every address). */
  html: boolean;
}

export async function robotsFor(origin: string, deps: FetchDeps = {}): Promise<Robots> {
  const got = await fetchBytes(`${origin}/robots.txt`, "text/plain", ROBOTS_BYTES, deps, 5000);
  if (!got.ok) {
    const base = { text: "", origin, html: false };
    return got.reason === "not_found" ? { ...base, reachable: true, turnedAway: false } : { ...base, reachable: false, turnedAway: got.reason === "turned_away" };
  }
  // Where the site answered from, after redirects ("acme.example" → "https://www.acme.example").
  let answered = origin;
  try {
    answered = new URL(got.url).origin;
  } catch {
    /* keep the one asked */
  }
  const text = got.bytes.toString("utf8");
  const html = /^\s*<(!doctype|html)\b/i.test(text);
  return { text: html ? "" : text, reachable: true, origin: answered, turnedAway: false, html };
}

/** May we read this URL, given the robots.txt of its origin? */
export function mayFetch(robots: Pick<Robots, "text" | "reachable">, url: string): boolean {
  if (!robots.reachable) return false;
  try {
    const u = new URL(url);
    return allowedFor(robots.text, ROBOTS_TOKEN, `${u.pathname}${u.search}`);
  } catch {
    return false;
  }
}
