import { safeFetch, readTextCapped } from "@/lib/security/ssrf";
import { htmlToText } from "./siteText";

/**
 * Fetch a brand's home page: the raw HTML (for what its markup and links say) and the page
 * reduced to text. SSRF-hardened (https only, private hosts refused, byte-capped). Null when
 * the site does not answer with a page. Shared by the website colours and the brand map.
 */

export interface Homepage {
  html: string;
  text: string;
  /** The page's address after its redirects. */
  baseUrl: string;
}

export async function fetchHomepage(
  domain: string,
  opts: { userAgent: string; timeoutMs?: number; maxHtmlBytes?: number; maxTextChars?: number },
): Promise<Homepage | null> {
  const host = domain.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  if (!host) return null;
  try {
    const res = await safeFetch(
      `https://${host}`,
      { headers: { "User-Agent": opts.userAgent, Accept: "text/html,text/plain" } },
      { timeoutMs: opts.timeoutMs ?? 8000, maxRedirects: 4 },
    );
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!ct.includes("text/html") && !ct.includes("text/plain")) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const baseUrl = res.url || `https://${host}`;
    const html = await readTextCapped(res, opts.maxHtmlBytes ?? 3 * 1024 * 1024);
    return { html, text: htmlToText(html).slice(0, opts.maxTextChars ?? 8000), baseUrl };
  } catch {
    return null;
  }
}
