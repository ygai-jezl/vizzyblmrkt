import { normalizeUrl } from "@/lib/content/blog/brief";
import { siteOf } from "@/lib/knowledge/site";

/**
 * The brand's own profile links, read off its home page: the `sameAs` its own schema markup
 * already lists first, then links to the usual profile sites. These are links the brand
 * itself publishes, so they are safe to suggest (a model never writes an address for the
 * map). Share buttons, intent links and other people's posts are left out, and one link is
 * kept per site.
 */

const MAX_LINKS = 8;

/** A profile site, and the path a profile (not a post or a share button) has on it. */
const PROFILE_SITES: Array<{ host: RegExp; path: RegExp }> = [
  { host: /^(?:[a-z]{2,3}\.)?linkedin\.com$/, path: /^\/(?:company|school|showcase)\/[^/?#]+\/?$/i },
  { host: /^(?:x|twitter)\.com$/, path: /^\/(?!intent\b|share\b|home\b|search\b|i\/)[A-Za-z0-9_]{1,15}\/?$/ },
  { host: /^(?:[a-z]{2,3}\.)?facebook\.com$/, path: /^\/(?!sharer|share|dialog|plugins|groups\/?$)[^/?#]+\/?$/i },
  { host: /^instagram\.com$/, path: /^\/(?!p\/|reel\/|explore\b)[A-Za-z0-9_.]{1,30}\/?$/ },
  { host: /^youtube\.com$/, path: /^\/(?:@[^/?#]+|c\/[^/?#]+|channel\/[^/?#]+|user\/[^/?#]+)\/?$/i },
  { host: /^github\.com$/, path: /^\/[A-Za-z0-9-]{1,39}\/?$/ },
  { host: /^crunchbase\.com$/, path: /^\/organization\/[^/?#]+\/?$/i },
  { host: /^tiktok\.com$/, path: /^\/@[^/?#]+\/?$/ },
  { host: /^(?:[a-z]{2,3}\.)?wikipedia\.org$/, path: /^\/wiki\/[^/?#]+$/ },
  { host: /^wikidata\.org$/, path: /^\/wiki\/Q[1-9]\d*$/ },
];

const hostOfUrl = (u: URL) => u.hostname.toLowerCase().replace(/^(?:www|m|mobile)\./, "");

/** A profile link this page could be offering for the brand, or null. */
function asProfile(raw: string, base: string, ownSites: Set<string>): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim(), base);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  u.protocol = "https:";
  u.hash = "";
  u.search = "";
  if (ownSites.has(siteOf(u.toString()))) return null;
  const host = hostOfUrl(u);
  const site = PROFILE_SITES.find((s) => s.host.test(host));
  if (!site || !site.path.test(u.pathname)) return null;
  return normalizeUrl(u.toString());
}

/** Every `sameAs` in the page's JSON-LD blocks, wherever it sits in them. */
function jsonLdSameAs(html: string): string[] {
  const out: string[] = [];
  const blocks = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "sameAs") {
        for (const v of Array.isArray(value) ? value : [value]) if (typeof v === "string") out.push(v);
      } else {
        walk(value);
      }
    }
  };
  for (const m of blocks) {
    try {
      walk(JSON.parse(m[1] ?? ""));
    } catch {
      /* not JSON: skip the block */
    }
  }
  return out;
}

export function profileLinksFromHtml(html: string, baseUrl: string, ownSites: (string | null | undefined)[]): string[] {
  const own = new Set(ownSites.map((s) => (s ? siteOf(s) : "")).filter(Boolean));
  const anchors = [...html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#][^"']*)["']/gi)].map((m) => m[1] ?? "");
  const out: string[] = [];
  const hosts = new Set<string>();
  for (const raw of [...jsonLdSameAs(html), ...anchors]) {
    const url = asProfile(raw, baseUrl, own);
    if (!url) continue;
    const host = hostOfUrl(new URL(url)).replace(/^[a-z]{2,3}\.(?=(?:linkedin|facebook|wikipedia)\.)/, "");
    if (hosts.has(host)) continue;
    hosts.add(host);
    out.push(url);
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}
