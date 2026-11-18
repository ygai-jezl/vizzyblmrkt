import { NodeType, parse, type HTMLElement, type Node } from "node-html-parser";
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
  /** Where it sat on a listing page (0 = top), for a post with no date. */
  rank?: number | null;
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

// ---------------------------------------------------------------------------------------------
// The date on each post's card, when the listing page shows one
// ---------------------------------------------------------------------------------------------

const MONTH_NUMBER: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
/** "13 Nov, 2026", "13th November 2026". */
const DAY_MONTH_YEAR = new RegExp(`(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH},?\\s+(\\d{4})(?!\\d)`, "i");
/** "Nov 13, 2026", "November 13th 2026". */
const MONTH_DAY_YEAR = new RegExp(`(?<![a-z])${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})(?!\\d)`, "i");
/** "2026-11-13". */
const ISO_DAY = /(?<!\d)((?:19|20)\d\d)-(\d\d)-(\d\d)(?!\d)/;

/**
 * The first date written out in some text, as YYYY-MM-DD: a day, a month by name and a year in
 * either order, or 2026-11-13. Never an all number form like 11/12/2026, which reads two ways.
 * Null for an impossible date or one more than a day ahead of `now`.
 */
export function dayFromText(text: string, now: Date = new Date()): string | null {
  const found: Array<{ at: number; y: number; m: number; d: number }> = [];
  const dmy = DAY_MONTH_YEAR.exec(text);
  if (dmy) found.push({ at: dmy.index, y: Number(dmy[3]), m: MONTH_NUMBER[dmy[2]!.slice(0, 3).toLowerCase()]!, d: Number(dmy[1]) });
  const mdy = MONTH_DAY_YEAR.exec(text);
  if (mdy) found.push({ at: mdy.index, y: Number(mdy[3]), m: MONTH_NUMBER[mdy[1]!.slice(0, 3).toLowerCase()]!, d: Number(mdy[2]) });
  const iso = ISO_DAY.exec(text);
  if (iso) found.push({ at: iso.index, y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) });
  const first = found.sort((a, b) => a.at - b.at)[0];
  if (!first) return null;
  const ms = Date.UTC(first.y, first.m - 1, first.d);
  const date = new Date(ms);
  if (first.y < 1995 || date.getUTCMonth() !== first.m - 1 || date.getUTCDate() !== first.d) return null;
  if (ms > now.getTime() + 86_400_000) return null;
  return date.toISOString().slice(0, 10);
}

/** One post on a listing page: where it sits (0 = top) and the date on its card, if it shows one. */
export interface ListingCard {
  url: string;
  publishedAt: string | null;
  rank: number;
}

/** How far up from a post's link we look for its card: never into a box that holds another post. */
const CARD_LEVELS = 4;

/** An element's words with a space between each piece of text, so "2026" and "Three" never run together. */
function wordsOf(node: Node): string {
  if (node.nodeType === NodeType.TEXT_NODE) return node.text;
  return node.childNodes.map(wordsOf).join(" ");
}

/** The date in one element: a <time datetime> first, else the first date in its words. */
function dateIn(el: HTMLElement, now: Date): string | null {
  for (const t of el.querySelectorAll("time")) {
    const day = dayFromText(t.getAttribute("datetime") ?? "", now) ?? dayFromText(wordsOf(t), now);
    if (day) return day;
  }
  return dayFromText(wordsOf(el).replace(/\s+/g, " "), now);
}

/**
 * The posts a listing page links to, in page order, each with the date on its card. A card is the
 * post's link, or the nearest box around it that holds no other post's link, so a date is never
 * taken from the card beside it. Posts on a page that shows no dates keep their order (`rank`).
 */
export function listingCards(html: string, pageUrl: string, newsUrl: string, site: string, now: Date = new Date()): ListingCard[] {
  const root = parse(html ?? "", { blockTextElements: { script: false, noscript: false, style: false, pre: true } });
  const self = normalizeUrl(newsUrl);
  const keyOf = new Map<HTMLElement, string>();
  const order: string[] = [];
  const anchors = new Map<string, HTMLElement[]>();
  for (const a of root.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") ?? "";
    if (!href || href.startsWith("#")) continue;
    let url: string;
    try {
      url = new URL(href, pageUrl).toString();
    } catch {
      continue;
    }
    if (!isPostOf(url, newsUrl, site)) continue;
    const key = normalizeUrl(url.replace(/^http:\/\//i, "https://"));
    if (!key || key === self) continue;
    keyOf.set(a, key);
    if (!anchors.has(key)) {
      if (order.length >= MAX_LINKS) continue;
      order.push(key);
      anchors.set(key, []);
    }
    anchors.get(key)!.push(a);
  }
  // Only another post's link stops the climb: links to tags or the author don't.
  const holdsOther = (el: HTMLElement, key: string) => el.querySelectorAll("a[href]").some((x) => keyOf.has(x) && keyOf.get(x) !== key);
  return order.map((url, rank) => {
    const own = anchors.get(url)!;
    let publishedAt: string | null = null;
    for (const a of own) {
      publishedAt = dateIn(a, now);
      if (publishedAt) break;
    }
    for (let el = own[0]!.parentNode as HTMLElement | null, up = 0; !publishedAt && el && up < CARD_LEVELS; el = el.parentNode as HTMLElement | null, up++) {
      if (!el.tagName || holdsOther(el, url)) break;
      publishedAt = dateIn(el, now);
    }
    return { url, publishedAt, rank };
  });
}
