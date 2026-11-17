/**
 * Read one competitor article by code: its main text (each link marked [L1], [L2]... so a
 * model can point at links by number and never has to write an address), its headings, its
 * links and what its own markup says about who wrote it and when.
 *
 * Addresses only ever come from here. Nothing in this file calls a model.
 */
import { parse, type HTMLElement, type Node } from "node-html-parser";
import { readPostMeta } from "@/lib/content/blog/research";
import { onSite } from "./sitemap";

/** Fewer words than this and the page isn't an article we can learn from (a stub, a gate). */
export const MIN_ARTICLE_WORDS = 150;
/** The text a model reads, at most. */
export const ARTICLE_TEXT_MAX = 40_000;
const MAX_LINKS = 120;
const MAX_HEADINGS = 25;

export interface ArticleLink {
  /** Its number in the text: "[L3]". */
  n: number;
  url: string;
  anchor: string;
  /** On the competitor's own site. */
  internal: boolean;
  /** Inside a sidebar, menu, footer or a related posts block, not the argument itself. */
  inAside: boolean;
}

export interface ArticleTrust {
  author: string | null;
  authorUrl: string | null;
  /** ISO day. */
  publishedAt: string | null;
  updatedAt: string | null;
  /** schema.org types the page declares, e.g. BlogPosting, Person, FAQPage. */
  schemaTypes: string[];
}

export interface ArticlePage {
  title: string;
  description: string;
  /** Where the text came from: the page's <article>, its <main>, or the body without its chrome. */
  region: "article" | "main" | "body";
  text: string;
  words: number;
  headings: string[];
  links: ArticleLink[];
  trust: ArticleTrust;
}

const SKIP = new Set(["script", "style", "noscript", "svg", "template", "iframe", "button", "select", "form", "nav"]);
const BLOCK = new Set([
  "p", "div", "section", "li", "ul", "ol", "br", "tr", "table", "blockquote", "figure", "figcaption",
  "article", "main", "header", "footer", "aside", "h1", "h2", "h3", "h4", "h5", "h6", "dl", "dt", "dd", "hr",
]);
const ASIDE_TAGS = new Set(["aside", "footer", "nav"]);
const ASIDE_CLASS = /related|recommend|read-?next|more-?(posts|articles)|sidebar|share|social|newsletter|subscribe/i;
const CHROME = "header, nav, footer, aside, script, style, noscript, svg, template, iframe";

const tidy = (s: string) => s.replace(/\s+/g, " ").trim();
const wordCount = (s: string) => (s.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;

function day(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const d = /^(\d{4}-\d{2}-\d{2})/.exec(raw.trim())?.[1];
  return d && !Number.isNaN(Date.parse(d)) ? d : null;
}

function absolute(href: string, pageUrl: string): string | null {
  const h = href.trim();
  if (!h || h.startsWith("#") || /^(mailto|tel|javascript|sms|data):/i.test(h)) return null;
  try {
    const u = new URL(h, pageUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

function asideOf(el: HTMLElement, region: HTMLElement): boolean {
  for (let p: HTMLElement | null = el.parentNode; p && p !== region; p = p.parentNode) {
    const tag = (p.rawTagName ?? "").toLowerCase();
    if (ASIDE_TAGS.has(tag)) return true;
    if (ASIDE_CLASS.test(p.getAttribute?.("class") ?? "")) return true;
  }
  return false;
}

/** The part of the page that holds the article. Several <article>s (cards) means the longest. */
function regionOf(root: HTMLElement): { el: HTMLElement; region: ArticlePage["region"] } {
  const main = root.querySelector("main") ?? root.querySelector("[role=main]");
  const articles = root.querySelectorAll("article");
  if (articles.length) {
    const best = articles.reduce((a, b) => (wordCount(b.text) > wordCount(a.text) ? b : a));
    const mainWords = main ? wordCount(main.text) : 0;
    if (wordCount(best.text) >= MIN_ARTICLE_WORDS || wordCount(best.text) * 2 >= mainWords) return { el: best, region: "article" };
  }
  if (main) return { el: main, region: "main" };
  const body = root.querySelector("body") ?? root;
  for (const el of body.querySelectorAll(CHROME)) el.remove();
  return { el: body, region: "body" };
}

interface Walk {
  parts: string[];
  links: ArticleLink[];
  pageUrl: string;
  site: string;
  region: HTMLElement;
}

function walk(node: Node, w: Walk): void {
  if (node.nodeType === 3) {
    w.parts.push(node.text);
    return;
  }
  if (node.nodeType !== 1) return;
  const el = node as HTMLElement;
  const tag = (el.rawTagName ?? "").toLowerCase();
  if (SKIP.has(tag)) return;
  if (tag === "a") {
    const anchor = tidy(el.text) || tidy(el.getAttribute("aria-label") ?? "") || tidy(el.querySelector("img")?.getAttribute("alt") ?? "");
    const url = absolute(el.getAttribute("href") ?? "", w.pageUrl);
    w.parts.push(` ${tidy(el.text)} `);
    if (url && w.links.length < MAX_LINKS) {
      const n = w.links.length + 1;
      w.links.push({ n, url, anchor: anchor.slice(0, 120), internal: onSite(url, w.site), inAside: asideOf(el, w.region) });
      w.parts.push(`[L${n}] `);
    }
    return;
  }
  const block = BLOCK.has(tag);
  if (block) w.parts.push("\n");
  if (tag === "h2" || tag === "h3") w.parts.push("## ");
  if (tag === "li") w.parts.push("- ");
  for (const child of el.childNodes) walk(child, w);
  if (block) w.parts.push("\n");
}

type Json = Record<string, unknown>;

/** Every node in the page's JSON-LD, with @graph and arrays flattened. */
function jsonLd(root: HTMLElement): Json[] {
  const out: Json[] = [];
  const add = (v: unknown, depth = 0) => {
    if (depth > 4 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach((x) => add(x, depth + 1));
    const o = v as Json;
    out.push(o);
    if (Array.isArray(o["@graph"])) add(o["@graph"], depth + 1);
  };
  for (const s of root.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      add(JSON.parse(s.rawText));
    } catch {
      // A broken block tells us nothing.
    }
  }
  return out;
}

const typesOf = (o: Json): string[] => (Array.isArray(o["@type"]) ? o["@type"] : [o["@type"]]).filter((t): t is string => typeof t === "string");

function trustOf(root: HTMLElement, nodes: Json[], html: string, w: Walk, now: Date): ArticleTrust {
  const byId = new Map(nodes.filter((n) => typeof n["@id"] === "string").map((n) => [n["@id"] as string, n]));
  const schemaTypes = [...new Set(nodes.flatMap(typesOf))].slice(0, 20);
  const post = nodes.find((n) => typesOf(n).some((t) => /^(BlogPosting|Article|NewsArticle|TechArticle|Report|ScholarlyArticle)$/.test(t)));
  let author: string | null = null;
  let authorUrl: string | null = null;
  const rawAuthor = post?.author;
  const first = (Array.isArray(rawAuthor) ? rawAuthor[0] : rawAuthor) as unknown;
  if (typeof first === "string") author = tidy(first);
  else if (first && typeof first === "object") {
    const a = first as Json;
    const full = typeof a["@id"] === "string" && !a.name ? (byId.get(a["@id"]) ?? a) : a;
    if (typeof full.name === "string") author = tidy(full.name);
    if (typeof full.url === "string") authorUrl = absolute(full.url, w.pageUrl);
  }
  const meta = (key: string) =>
    root.querySelector(`meta[property="${key}"]`)?.getAttribute("content") ?? root.querySelector(`meta[name="${key}"]`)?.getAttribute("content") ?? null;
  if (!author) author = tidy(meta("author") ?? "") || null;
  if (!authorUrl) {
    const rel = root.querySelector('a[rel~="author"]')?.getAttribute("href") ?? root.querySelector('link[rel="author"]')?.getAttribute("href");
    authorUrl = (rel && absolute(rel, w.pageUrl)) || w.links.find((l) => l.internal && /\/(authors?|team|people|writers?)\//i.test(l.url))?.url || null;
  }
  return {
    author: author ? author.slice(0, 120) : null,
    authorUrl,
    publishedAt: day(post?.datePublished) ?? readPostMeta(html, now).publishedAt,
    updatedAt: day(post?.dateModified) ?? day(meta("article:modified_time")),
    schemaTypes,
  };
}

/** Read one article page. Never throws: a page we can't make sense of comes back nearly empty. */
export function readArticlePage(html: string, pageUrl: string, site: string, now = new Date()): ArticlePage {
  const root = parse(html, { comment: false });
  const { title, description } = readPostMeta(html, now);
  // Before the region is chosen: the body fallback strips scripts, JSON-LD among them.
  const nodes = jsonLd(root);
  const { el, region } = regionOf(root);
  const w: Walk = { parts: [], links: [], pageUrl, site, region: el };
  walk(el, w);
  const trust = trustOf(root, nodes, html, w, now);
  const text = w.parts
    .join("")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim()
    .slice(0, ARTICLE_TEXT_MAX);
  const headings = el
    .querySelectorAll("h2, h3")
    .map((h) => tidy(h.text).slice(0, 120))
    .filter(Boolean)
    .slice(0, MAX_HEADINGS);
  return {
    title,
    description,
    region,
    text,
    words: wordCount(text.replace(/\[L\d+\]/g, "")),
    headings,
    links: w.links,
    trust,
  };
}
