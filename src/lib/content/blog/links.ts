import type { BlogLink, BlogLinkIntent } from "@/lib/types/contentPlan";
import { hostOf, isCodeHostUrl, normalizeUrl } from "./brief";

/**
 * Which of the brand's own pages a blog article should link to. The pages come from
 * what the programme has already indexed — a crawled site gives real URLs; a connected
 * repo gives page FILES, from which a route can be read for the common web frameworks
 * (and is only ever suggested once the live site answers for it). Each page is sorted by
 * what it is for, so the article can send a reader to a page that converts (pricing, a
 * demo, a sign-up) and to pages that go deeper. Pure + client-safe.
 */

/** A page the programme knows about. */
export interface KnownPage {
  url: string;
  title: string;
}

const INTENT_RULES: { intent: BlogLinkIntent; path: RegExp; title: RegExp }[] = [
  {
    intent: "convert",
    path: /(^|\/)(pricing|plans?|price|demo|book(-a)?(-demo|-call)?|trial|free-trial|start|get-started|signup|sign-up|register|join|waitlist|contact(-us)?|contact-sales|sales|quote|buy|checkout|subscribe)(\/|$)/i,
    title: /\b(pricing|plans|book a demo|request a demo|free trial|get started|sign up|contact sales|talk to sales|join the waitlist)\b/i,
  },
  {
    intent: "compare",
    path: /(^|\/)(compare|comparison|vs|versus|alternatives?)(\/|$)|-vs-|-alternatives?(\/|$)/i,
    title: /\b(vs\.?|versus|alternatives?|compared)\b/i,
  },
  {
    intent: "proof",
    path: /(^|\/)(customers?|case-stud(y|ies)|stories|success-stories|testimonials|reviews|results)(\/|$)/i,
    title: /\b(case study|customer story|testimonial|success story)\b/i,
  },
  {
    intent: "product",
    path: /(^|\/)(product|products|features?|platform|solutions?|how-it-works|use-cases?|integrations?|tour|overview)(\/|$)/i,
    title: /\b(features|how it works|integrations|use cases|product tour)\b/i,
  },
];

/** Pages no article should send a reader to. */
const NEVER =
  /(^|\/)(login|log-in|signin|sign-in|logout|admin|dashboard|account|settings|api|auth|oauth|cart|privacy|terms|legal|cookies?|unsubscribe|404|500|search|tag|tags|category|author|feed|rss|sitemap[^/]*)(\/|$)|\.(xml|json|pdf|png|jpe?g|svg|css|js)$/i;

/** A blog post or a docs page reads; it does not convert, whatever its title says. */
const CONTENT_SECTION =
  /(^|\/)(blog|news|articles?|posts?|docs?|documentation|help|guides?|resources|learn|academy|changelog|press|glossary)(\/|$)/i;

/** What a page is for, from its path first (reliable) and its title second. */
export function linkIntent(url: string, title = ""): BlogLinkIntent {
  let path = "";
  try {
    path = new URL(url).pathname;
  } catch {
    return "learn";
  }
  if (CONTENT_SECTION.test(path)) {
    // Inside the blog or the docs, only a comparison or a customer story is more than reading.
    const rule = INTENT_RULES.find((r) => (r.intent === "compare" || r.intent === "proof") && r.path.test(path));
    return rule?.intent ?? "learn";
  }
  for (const rule of INTENT_RULES) if (rule.path.test(path)) return rule.intent;
  for (const rule of INTENT_RULES) if (rule.title.test(title)) return rule.intent;
  return "learn";
}

/** A label for a link: the page's title without the site's name, else its path in words. */
export function linkLabel(url: string, title = ""): string {
  const clean = title
    .replace(/\s+/g, " ")
    .split(/\s[|–—·-]\s/)[0]!
    .trim();
  if (clean && clean.length <= 90 && !/^https?:\/\//i.test(clean)) return clean;
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    if (!last) return "Home";
    const words = decodeURIComponent(last).replace(/[-_]+/g, " ").trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
  } catch {
    return clean.slice(0, 90);
  }
}

/** A page an article could link to: https, not a code host, and not a utility page.
 *  WHOSE page it is, this cannot tell — the caller hands in only the brand's own. */
export function isLinkablePage(url: string): boolean {
  const n = normalizeUrl(url);
  if (!n.startsWith("https://") || isCodeHostUrl(n)) return false;
  try {
    return !NEVER.test(new URL(n).pathname);
  } catch {
    return false;
  }
}

const PER_INTENT: Record<BlogLinkIntent, number> = { convert: 3, product: 2, compare: 1, proof: 2, learn: 3 };
const ORDER: BlogLinkIntent[] = ["convert", "product", "proof", "compare", "learn"];

/**
 * Choose the link targets for an article: a few pages of each kind, conversion pages
 * first. `pages` must be the brand's OWN pages only (research keeps those on the brand's
 * site): every one may be offered to the writer as a page of the brand's, and a pricing
 * page as the place to send the reader. `related` are the pages the knowledge search
 * found for this article's topic —
 * they win the "goes deeper" places, and break ties everywhere else. Shallow pages beat
 * deep ones (a /pricing page beats /blog/2021/pricing-update).
 */
export function chooseLinkTargets(
  pages: KnownPage[],
  opts: { related?: string[]; exclude?: (string | null | undefined)[]; max?: number } = {},
): BlogLink[] {
  const related = new Map((opts.related ?? []).map((u, i) => [normalizeUrl(u), i] as const));
  const exclude = new Set((opts.exclude ?? []).map((u) => (u ? normalizeUrl(u) : "")));
  const byUrl = new Map<string, KnownPage>();
  for (const p of pages) {
    const n = normalizeUrl(p.url);
    if (!n || exclude.has(n) || !isLinkablePage(n) || byUrl.has(n)) continue;
    byUrl.set(n, { url: n, title: p.title });
  }
  const depth = (u: string) => new URL(u).pathname.split("/").filter(Boolean).length;
  const ranked = [...byUrl.values()]
    .map((p) => ({ ...p, intent: linkIntent(p.url, p.title), rel: related.get(p.url) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.rel - b.rel || depth(a.url) - depth(b.url) || a.url.length - b.url.length);

  const out: BlogLink[] = [];
  for (const intent of ORDER) {
    const pool = ranked.filter((p) => p.intent === intent);
    // "Goes deeper" pages must be about this article's topic; the home page is not a deeper page.
    const pick = intent === "learn" ? pool.filter((p) => related.has(p.url) && depth(p.url) > 0) : pool;
    for (const p of pick.slice(0, PER_INTENT[intent])) {
      out.push({ url: p.url, label: linkLabel(p.url, p.title), intent, by: "research" });
    }
  }
  return out.slice(0, opts.max ?? 8);
}

// ── Routes from a connected repo ────────────────────────────────────────────

/** First path segments that are never public marketing pages. */
const PRIVATE_SEGMENT =
  /^(api|admin|dashboard|app|account|settings|auth|internal|embed|invite|unsubscribe|login|logout|signin|_.*|\..*)$/i;

function routeFromSegments(segments: string[]): string | null {
  const kept: string[] = [];
  for (const [i, seg] of segments.entries()) {
    if (!seg || /^\(.*\)$/.test(seg)) continue; // a route group adds no path
    if (seg.startsWith("@")) return null; // a parallel slot is not a page of its own
    if (/^\[.*\]$/.test(seg)) {
      // A leading [locale] is a language prefix; any other dynamic segment has no fixed URL.
      if (i === 0 && /^\[(locale|lang|language)\]$/i.test(seg)) continue;
      return null;
    }
    kept.push(seg);
  }
  if (kept[0] && PRIVATE_SEGMENT.test(kept[0])) return null;
  if (kept.some((s) => !/^[A-Za-z0-9._~-]+$/.test(s))) return null;
  return `/${kept.join("/")}`;
}

/**
 * The public route a repo file serves, for the web frameworks that map files to routes
 * (Next.js app + pages routers, Astro, Nuxt, SvelteKit). Null for every other file, and
 * for a route whose URL isn't fixed (a `[slug]` page). A GUESS — callers only suggest it
 * once the live site answers for it.
 */
export function routeFromRepoPath(path: string): string | null {
  const p = (path ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  const app = /(?:^|\/)app\/((?:[^/]+\/)*)page\.(?:tsx|jsx|ts|js|mdx|md)$/.exec(p);
  if (app) return routeFromSegments((app[1] ?? "").split("/").filter(Boolean));
  const svelte = /(?:^|\/)src\/routes\/((?:[^/]+\/)*)\+page\.svelte$/.exec(p);
  if (svelte) return routeFromSegments((svelte[1] ?? "").split("/").filter(Boolean));
  const pages = /(?:^|\/)pages\/(.+)\.(?:tsx|jsx|ts|js|mdx|md|astro|vue)$/.exec(p);
  if (pages) {
    const segments = (pages[1] ?? "").split("/");
    if (segments[segments.length - 1] === "index") segments.pop();
    return routeFromSegments(segments);
  }
  return null;
}

/** Candidate pages from repo file paths, on `origin` (the brand's site). Deduped, capped. */
export function pagesFromRepoPaths(paths: string[], origin: string, max = 24): KnownPage[] {
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    return [];
  }
  if (base.protocol !== "https:" || !hostOf(base.toString())) return [];
  const seen = new Set<string>();
  const out: KnownPage[] = [];
  for (const path of paths) {
    const route = routeFromRepoPath(path);
    if (route === null) continue;
    const url = normalizeUrl(new URL(route, base.origin).toString());
    if (!url || seen.has(url) || !isLinkablePage(url)) continue;
    seen.add(url);
    out.push({ url, title: "" });
  }
  // Conversion and product pages first, so the cap never squeezes them out.
  const weight = (p: KnownPage) => ORDER.indexOf(linkIntent(p.url));
  return out.sort((a, b) => weight(a) - weight(b) || a.url.length - b.url.length).slice(0, max);
}
