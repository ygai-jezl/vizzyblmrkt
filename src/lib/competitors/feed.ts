import { isLinkablePage } from "@/lib/content/blog/links";
import { normalizeUrl } from "@/lib/content/blog/brief";
import { onSite } from "./sitemap";

/**
 * A competitor's news page, read three ways: its feed (RSS or Atom), the sitemap files that list
 * its posts, or the links on the page itself. Pure: no fetching here.
 */

export interface FeedItem {
  url: string;
  title: string;
  publishedAt: string | null;
}

/** Items read from one feed at most. */
const MAX_ITEMS = 200;
/** Post links read from one listing page at most. */
const MAX_LINKS = 200;

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#0?39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_m, n: string) => {
      const c = Number(n);
      return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : "";
    })
    .replace(/\s+/g, " ")
    .trim();
}

function attr(tag: string, name: string): string {
  const m = new RegExp(`\\s${name}\\s*=\\s*(["'])([^"']*)\\1`, "i").exec(tag);
  return m?.[2] ?? "";
}

/** The feed a page links to in its head (`<link rel="alternate" type="application/rss+xml">`), on the same site. */
export function feedLinkFromHtml(html: string, pageUrl: string, site: string): string | null {
  for (const m of (html ?? "").matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\brel\s*=\s*["'][^"']*\balternate\b/i.test(tag)) continue;
    if (!/\btype\s*=\s*["']application\/(rss|atom)\+xml["']/i.test(tag)) continue;
    const href = attr(tag, "href");
    if (!href) continue;
    try {
      const url = new URL(decode(href), pageUrl).toString();
      if (onSite(url, site)) return url;
    } catch {
      /* not an address */
    }
  }
  return null;
}

function dayOf(raw: string): string | null {
  const t = Date.parse(raw.trim());
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

/** A feed's items: RSS <item> or Atom <entry>, each with its link, title and date. */
export function parseFeed(xml: string, baseUrl: string): FeedItem[] {
  const out: FeedItem[] = [];
  const text = xml ?? "";
  const atom = /<feed\b[^>]*xmlns=["']http:\/\/www\.w3\.org\/2005\/Atom["']/i.test(text.slice(0, 4000));
  const blocks = atom ? text.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi) : text.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi);
  for (const m of blocks) {
    const inner = m[1] ?? "";
    let link = "";
    if (atom) {
      const links = [...inner.matchAll(/<link\b[^>]*>/gi)].map((l) => l[0]);
      const pick = links.find((l) => /\brel\s*=\s*["']alternate["']/i.test(l)) ?? links.find((l) => !/\brel\s*=/i.test(l)) ?? links[0];
      link = pick ? decode(attr(pick, "href")) : "";
    } else {
      link = decode(/<link\b[^>]*>([\s\S]*?)<\/link>/i.exec(inner)?.[1] ?? "") || decode(/<guid\b[^>]*isPermaLink=["']true["'][^>]*>([\s\S]*?)<\/guid>/i.exec(inner)?.[1] ?? "");
    }
    if (!link) continue;
    let url: string;
    try {
      url = new URL(link, baseUrl).toString();
    } catch {
      continue;
    }
    const title = decode(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(inner)?.[1] ?? "").slice(0, 200);
    const dated = /<(?:pubDate|published|updated|dc:date)\b[^>]*>([\s\S]*?)<\/(?:pubDate|published|updated|dc:date)>/i.exec(inner)?.[1] ?? "";
    out.push({ url, title, publishedAt: dated ? dayOf(decode(dated)) : null });
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

/** The path a news page lists its posts under: "/news" for "/news/" or "/news?page=1". */
export function newsPrefix(newsUrl: string): string {
  try {
    return new URL(newsUrl).pathname.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

/** Page 2 of a list, a tag or a category is the list again, not a post. */
const NOT_A_POST = /\/(page|tag|tags|category|categories|author|authors|topic|topics|archive|archives)(\/|$)|[?&]page=/i;
/** A date archive: a path that ends in a year, a month or a day ("/blog/2026/11/13"), not a post under one. */
const DATE_ARCHIVE = /\/(19|20)\d{2}(\/\d{1,2}){0,2}\/?$/;

/**
 * Is `url` a post of this news page? On the same site, under the news page's path and deeper
 * than it (a news page at the top of the site counts any page one or two levels down), and not a
 * list page, a feed or an asset.
 */
export function isPostOf(url: string, newsUrl: string, site: string): boolean {
  if (!onSite(url, site)) return false;
  const n = normalizeUrl(url.replace(/^http:\/\//i, "https://"));
  if (!n || !isLinkablePage(n) || NOT_A_POST.test(n)) return false;
  let path: string;
  try {
    path = new URL(n).pathname;
  } catch {
    return false;
  }
  if (DATE_ARCHIVE.test(path)) return false;
  const prefix = newsPrefix(newsUrl);
  if (prefix) return path.startsWith(`${prefix}/`) && path.length > prefix.length + 1;
  const depth = path.split("/").filter(Boolean).length;
  return depth >= 1 && depth <= 2;
}

/** The posts a listing page links to: same site, under the news page, each once (normalised). */
export function listingLinks(html: string, pageUrl: string, newsUrl: string, site: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const self = normalizeUrl(newsUrl);
  for (const m of (html ?? "").matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#][^"']*)["']/gi)) {
    let url: string;
    try {
      url = new URL(decode(m[1] ?? ""), pageUrl).toString();
    } catch {
      continue;
    }
    if (!isPostOf(url, newsUrl, site)) continue;
    const key = normalizeUrl(url.replace(/^http:\/\//i, "https://"));
    if (!key || key === self || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

/** How many links on a page sit under its own path: a news page lists at least a few. */
export function postLinkCount(html: string, pageUrl: string, site: string): number {
  return listingLinks(html, pageUrl, pageUrl, site).length;
}
