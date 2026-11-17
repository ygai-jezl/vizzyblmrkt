import { siteOf } from "@/lib/knowledge/site";
import { COMPETITOR_LIMITS } from "@/lib/types/competitor";

/**
 * Reading a sitemap without an XML library: a sitemap is a flat list of <url> (or, for an index,
 * <sitemap>) blocks, each with a <loc> and maybe a <lastmod>. Also a plain text sitemap, one URL a
 * line, which the sitemaps protocol allows. Pure: no fetching here.
 */

export interface SitemapEntry {
  loc: string;
  /** "YYYY-MM-DD", or null when the entry has none we can read. */
  lastmod: string | null;
}

export interface ParsedSitemap {
  kind: "index" | "urlset" | "text" | "unknown";
  entries: SitemapEntry[];
}

/** Entries read from one file at most: a backstop past the protocol's own 50,000. */
const MAX_ENTRIES = 60_000;

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#0?39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, n: string) => safeCodePoint(Number(n)))
    .trim();
}

function safeCodePoint(n: number): string {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
}

/** A lastmod as a day, or null ("2026-11-02T10:00:00+00:00" → "2026-11-02"). */
function dayOf(raw: string | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec((raw ?? "").trim());
  if (!m) return null;
  const day = `${m[1]}-${m[2]}-${m[3]}`;
  return Number.isNaN(Date.parse(day)) ? null : day;
}

/** Extension namespaces whose own <loc> (an image's, a video's) is not the page's. */
const OTHER_NS = new Set(["image", "video", "news", "xhtml", "mobile"]);

/** The first <name> in a block that belongs to the sitemap itself (no prefix, or one that isn't an extension's). */
function firstTag(inner: string, name: string): string {
  const re = new RegExp(`<(?:([\\w-]+):)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, "gi");
  for (const m of inner.matchAll(re)) {
    if (m[1] && OTHER_NS.has(m[1].toLowerCase())) continue;
    return m[2] ?? "";
  }
  return "";
}

export function parseSitemap(text: string): ParsedSitemap {
  const body = text ?? "";
  const head = body.slice(0, 4000);
  const index = /<(?:[\w-]+:)?sitemapindex\b/i.test(head) || /<(?:[\w-]+:)?sitemapindex\b/i.test(body.slice(0, 200_000));
  const urlset = !index && (/<(?:[\w-]+:)?urlset\b/i.test(head) || /<(?:[\w-]+:)?urlset\b/i.test(body.slice(0, 200_000)));
  if (index || urlset) {
    const block = index ? /<(?:[\w-]+:)?sitemap\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?sitemap>/gi : /<(?:[\w-]+:)?url\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?url>/gi;
    const entries: SitemapEntry[] = [];
    for (const m of body.matchAll(block)) {
      const inner = m[1] ?? "";
      const loc = decodeXml(firstTag(inner, "loc"));
      if (!loc) continue;
      entries.push({ loc, lastmod: dayOf(decodeXml(firstTag(inner, "lastmod"))) });
      if (entries.length >= MAX_ENTRIES) break;
    }
    return { kind: index ? "index" : "urlset", entries };
  }
  // Not XML: a text sitemap is one absolute URL a line and nothing else.
  if (!/^\s*</.test(head)) {
    const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length && lines.slice(0, 20).every((l) => /^https?:\/\/\S+$/i.test(l))) {
      return { kind: "text", entries: lines.filter((l) => /^https?:\/\/\S+$/i.test(l)).slice(0, MAX_ENTRIES).map((loc) => ({ loc, lastmod: null })) };
    }
  }
  return { kind: "unknown", entries: [] };
}

/** "www.acme.example" and "acme.example" are the same front door. */
function bareHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

/**
 * A page's key in a baseline: its path (and query, without tracking parameters) when it is on
 * the competitor's own host, or "//host/path" on another host of the same site (a blog on a
 * subdomain). Null for anything off the site, or not a web address. Cut to MAX_PATH.
 */
export function pageKey(raw: string, website: string, site: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (siteOf(u.hostname) !== site) return null;
  for (const key of [...u.searchParams.keys()]) {
    if (/^(utm_[a-z]+|gclid|fbclid|mc_[a-z]+|ref|ref_src)$/i.test(key)) u.searchParams.delete(key);
  }
  const path = (u.pathname.replace(/\/+$/, "") || "/") + (u.searchParams.toString() ? `?${u.searchParams.toString()}` : "");
  let own = false;
  try {
    own = bareHost(new URL(website).hostname) === bareHost(u.hostname);
  } catch {
    own = false;
  }
  const key = own ? path : `//${bareHost(u.hostname)}${path === "/" ? "" : path}`;
  return key.slice(0, COMPETITOR_LIMITS.MAX_PATH).replace(/[\t\n\r]/g, " ");
}

/** The address a key stands for, to link to it. */
export function keyUrl(key: string, website: string): string {
  if (key.startsWith("//")) return `https:${key}`;
  return `${website.replace(/\/+$/, "")}${key}`;
}

/** A sitemap address worth following: on the competitor's own site, http(s). */
export function onSite(raw: string, site: string): boolean {
  try {
    const u = new URL(raw);
    return (u.protocol === "https:" || u.protocol === "http:") && siteOf(u.hostname) === site;
  } catch {
    return false;
  }
}

/** http is read as https: safeFetch only speaks https, and a sitemap's own http links still name the page. */
export function asHttps(raw: string): string {
  return raw.replace(/^http:\/\//i, "https://");
}

/** One baseline line: "path\tday". */
export function line(key: string, lastmod: string | null): string {
  return `${key}\t${lastmod ?? ""}`;
}

export interface BaselinePage {
  key: string;
  lastmod: string | null;
}

/** The pages in a set of chunk documents, each once (the first date seen wins). */
export function pagesFromChunks(chunks: Array<{ n: number; lines: string }>): BaselinePage[] {
  const seen = new Map<string, string | null>();
  for (const c of [...chunks].sort((a, b) => a.n - b.n)) {
    for (const l of c.lines.split("\n")) {
      if (!l) continue;
      const tab = l.indexOf("\t");
      const key = tab === -1 ? l : l.slice(0, tab);
      const day = tab === -1 ? "" : l.slice(tab + 1);
      if (!key || seen.has(key)) continue;
      seen.set(key, day || null);
    }
  }
  return [...seen].map(([key, lastmod]) => ({ key, lastmod }));
}

/** Split lines into chunks of at most `maxBytes` (UTF-8), keeping each line whole. */
export function chunkLines(lines: string[], maxBytes: number = COMPETITOR_LIMITS.CHUNK_BYTES): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const l of lines) {
    const bytes = Buffer.byteLength(l, "utf8") + 1;
    if (size + bytes > maxBytes && current.length) {
      out.push(current.join("\n"));
      current = [];
      size = 0;
    }
    current.push(l);
    size += bytes;
  }
  if (current.length) out.push(current.join("\n"));
  return out;
}

/** The usual places a site keeps its sitemap, tried in order when robots.txt names none. */
export const COMMON_SITEMAP_PATHS = ["/sitemap.xml", "/sitemap_index.xml", "/sitemap-index.xml", "/wp-sitemap.xml"];
