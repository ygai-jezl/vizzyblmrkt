import { parse, type HTMLElement } from "node-html-parser";
import TurndownService from "turndown";
import { safeFetch, assertPublicUrl } from "../ssrf";
import { renderPage, closeBrowser } from "../render";

/**
 * Same-origin shallow web crawler. Fetches HTML (SSRF-safe, manual redirects),
 * strips chrome (nav/header/footer/script/style/aside), and converts the main
 * content to markdown. Server-rendered pages convert directly; for JavaScript-
 * rendered (SPA) pages whose static HTML is thin, it FALLS BACK to a headless
 * browser (render.ts) that executes JS, then re-extracts — so SPA sites index too.
 */

const UA = "VizzyblKnowledgeBot/1.0 (+https://yougrow.ai)";
// Below this many chars of extracted markdown, retry the page via headless render.
const MIN_STATIC_CHARS = 200;
const STRIP = ["script", "style", "noscript", "nav", "header", "footer", "aside", "form", "svg", "iframe"];

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

export interface CrawledPage {
  url: string;
  title: string;
  markdown: string;
}

function extract(
  html: string,
  pageUrl: string,
  origin: string,
): { title: string; markdown: string; links: string[] } {
  const root = parse(html, { comment: false });
  for (const sel of STRIP) root.querySelectorAll(sel).forEach((n) => n.remove());

  const title =
    root.querySelector("title")?.textContent?.trim() ||
    root.querySelector("h1")?.textContent?.trim() ||
    pageUrl;

  const main: HTMLElement =
    root.querySelector("main") ||
    root.querySelector("article") ||
    root.querySelector('[role="main"]') ||
    root.querySelector("body") ||
    root;

  const markdown = turndown.turndown(main.innerHTML || "").trim();

  const links: string[] = [];
  for (const a of root.querySelectorAll("a")) {
    const href = a.getAttribute("href");
    if (!href || href.startsWith("#") || href.startsWith("mailto:")) continue;
    let abs: URL;
    try {
      abs = new URL(href, pageUrl);
    } catch {
      continue;
    }
    abs.hash = "";
    if (abs.origin === origin && abs.protocol === "https:") links.push(abs.toString());
  }
  return { title, markdown, links };
}

export async function crawlAndCollect(opts: {
  sourceUri: string;
  maxPages: number;
}): Promise<{ pages: CrawledPage[]; pagesProcessed: number }> {
  const start = await assertPublicUrl(opts.sourceUri);
  const origin = start.origin;
  const seen = new Set<string>();
  const queue: string[] = [start.toString()];
  const pages: CrawledPage[] = [];

  try {
    while (queue.length > 0 && pages.length < opts.maxPages) {
      const next = queue.shift()!;
      if (seen.has(next)) continue;
      seen.add(next);
      try {
        const res = await safeFetch(next, { headers: { "User-Agent": UA } });
        if (!res.ok) continue;
        const ct = res.headers.get("content-type") ?? "";
        if (!ct.includes("text/html")) continue;
        const html = await res.text();
        let { title, markdown, links } = extract(html, next, origin);
        // SPA fallback: static HTML was thin → render with JS and re-extract.
        if (markdown.length < MIN_STATIC_CHARS) {
          const rendered = await renderPage(next).catch(() => null);
          if (rendered) {
            const r = extract(rendered, next, origin);
            if (r.markdown.length > markdown.length) ({ title, markdown, links } = r);
          }
        }
        if (markdown) pages.push({ url: next, title, markdown });
        for (const link of links) {
          if (!seen.has(link) && queue.length + pages.length < opts.maxPages * 4) {
            queue.push(link);
          }
        }
      } catch {
        // skip a page that fails SSRF/fetch/parse/render; keep crawling the rest
        continue;
      }
    }
  } finally {
    await closeBrowser(); // tear down the shared browser if the fallback launched it
  }
  return { pages, pagesProcessed: pages.length };
}
