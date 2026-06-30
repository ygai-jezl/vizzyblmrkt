import { chromium, type Browser } from "playwright";
import { isHostPublic } from "./ssrf";

/**
 * Headless rendering for JavaScript-rendered (SPA) sites — the static fetch path in
 * sources/web.ts only sees server HTML, so a client-rendered page yields nothing.
 * Used as a FALLBACK when static extraction is thin. One Chromium instance is reused
 * across a crawl (launched lazily, closed in web.ts's finally).
 *
 * SECURITY (SSRF): a browser would otherwise load every subresource a page references
 * — including an attacker-planted request to an internal IP / cloud metadata. Every
 * request is intercepted: non-content asset types are dropped (also a big speed-up),
 * and any host that resolves to a private/internal address is aborted (reusing the
 * same screen as safeFetch). Runs --no-sandbox (Cloud Run has no user namespaces),
 * which the request screen compensates for.
 */

const UA = "VizzyblKnowledgeBot/1.0 (+https://yougrow.ai)";
// Asset types that never contribute text — block them (SSRF surface + load speed).
const BLOCKED_TYPES = new Set(["image", "media", "font", "stylesheet"]);
const NAV_TIMEOUT_MS = 20_000;
const IDLE_TIMEOUT_MS = 8_000;
const HYDRATE_SETTLE_MS = 600;

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
  }
  return browserPromise;
}

/** Close the shared browser (call in the crawl's finally). Safe to call when unused. */
export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  const p = browserPromise;
  browserPromise = null;
  const b = await p.catch(() => null);
  if (b) await b.close().catch(() => {});
}

/**
 * Render `url` with a headless browser (executes JS) and return the fully-rendered
 * HTML, or null on timeout/failure. The caller has already SSRF-screened `url`; this
 * additionally screens every subresource the page requests.
 */
export async function renderPage(url: string): Promise<string | null> {
  let context;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({ userAgent: UA, javaScriptEnabled: true });
  } catch {
    return null; // browser failed to launch (e.g. missing chromium) — degrade to static
  }
  await context.route("**/*", async (route) => {
    const req = route.request();
    if (BLOCKED_TYPES.has(req.resourceType())) return route.abort();
    try {
      const u = new URL(req.url());
      if (u.protocol !== "https:" && u.protocol !== "http:") return route.abort();
      if (!(await isHostPublic(u.hostname))) return route.abort();
      return route.continue();
    } catch {
      return route.abort();
    }
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    // Best-effort wait for the SPA to fetch + render, then a short hydration settle.
    await page.waitForLoadState("networkidle", { timeout: IDLE_TIMEOUT_MS }).catch(() => {});
    await page.waitForTimeout(HYDRATE_SETTLE_MS);
    return await page.content();
  } catch {
    return null;
  } finally {
    await context.close().catch(() => {});
  }
}
