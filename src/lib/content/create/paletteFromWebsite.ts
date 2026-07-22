import { safeFetch, readTextCapped, readBytesCapped } from "@/lib/security/ssrf";
import { renderPrompt } from "@/lib/agents/prompts/registry";
import { generateText, parseFirstJson } from "@/lib/agents/gemini";
import { clampColors, harvestCssColors } from "./colorPalette";
import { htmlToText, stripFenceDelimiters } from "./siteText";
import {
  extractPaletteFromImageBytes,
  IMAGE_PALETTE_MIME,
  IMAGE_PALETTE_MAX_BYTES,
} from "./paletteFromImage";
import type { PaletteColor } from "@/lib/types/tenant";

/**
 * Extract a brand's colour palette from its WEBSITE. Two signals, both SSRF-hardened via
 * safeFetch (HTTPS-only, DNS-rebinding-safe, byte-capped):
 *  1. CSS tokens harvested from the homepage's inline styles + <style> blocks.
 *  2. A vision pass over the site's og:image / apple-touch-icon (real brand colours usually
 *     live in the logo, not the CSS).
 * Gemini then curates the true brand palette from those candidates + the page text (fenced as
 * UNTRUSTED). Never persists — the caller returns candidates for review. Fail-soft: null when
 * nothing usable is found or the model is unavailable.
 */

const FETCH_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 3 * 1024 * 1024;
const MAX_SAMPLE_CHARS = 8000;
const MAX_TOKENS = 200;

interface Homepage {
  html: string;
  text: string;
  baseUrl: string;
}

/** Fetch + reduce the homepage. Returns raw html (for token/icon harvest) + reduced text. */
async function fetchHomepage(domain: string): Promise<Homepage | null> {
  try {
    const res = await safeFetch(
      `https://${domain}`,
      { headers: { "User-Agent": "Vizzybl-BrandColors/1.0", Accept: "text/html,text/plain" } },
      { timeoutMs: FETCH_TIMEOUT_MS, maxRedirects: 4 },
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
    const baseUrl = res.url || `https://${domain}`;
    const html = await readTextCapped(res, MAX_HTML_BYTES);
    return { html, text: htmlToText(html).slice(0, MAX_SAMPLE_CHARS), baseUrl };
  } catch {
    return null;
  }
}

/**
 * Pick the best brand-image URL from the page head — og:image / twitter:image first (usually a
 * rich brand banner), then apple-touch-icon / icon links. Resolved to an absolute https URL;
 * safeFetch re-screens it at connect time.
 */
export function extractBrandImageUrl(html: string, baseUrl: string): string | null {
  const candidates: string[] = [];
  const metaRe = /<meta\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = metaRe.exec(html)) !== null) {
    const tag = m[0];
    if (/(?:property|name)=["'](?:og:image|twitter:image)["']/i.test(tag)) {
      const c = /content=["']([^"']+)["']/i.exec(tag);
      if (c?.[1]) candidates.push(c[1]);
    }
  }
  const linkRe = /<link\b[^>]*>/gi;
  while ((m = linkRe.exec(html)) !== null) {
    const tag = m[0];
    if (/rel=["'][^"']*icon[^"']*["']/i.test(tag)) {
      const c = /href=["']([^"']+)["']/i.exec(tag);
      if (c?.[1]) candidates.push(c[1]);
    }
  }
  for (const c of candidates) {
    try {
      const u = new URL(c, baseUrl);
      if (u.protocol === "https:") return u.toString();
    } catch {
      /* skip unparseable */
    }
  }
  return null;
}

/** Fetch + vision-extract colours from the site's brand image. Best-effort; null on any miss. */
async function brandImageColors(html: string, baseUrl: string): Promise<PaletteColor[] | null> {
  const url = extractBrandImageUrl(html, baseUrl);
  if (!url) return null;
  try {
    const res = await safeFetch(
      url,
      { headers: { Accept: "image/*" } },
      { timeoutMs: FETCH_TIMEOUT_MS, maxRedirects: 3 },
    );
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const mime = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!IMAGE_PALETTE_MIME.has(mime)) {
      await res.body?.cancel().catch(() => {});
      return null; // skip ICO/SVG/unknown — vision handles png/jpeg/webp reliably
    }
    const bytes = await readBytesCapped(res, IMAGE_PALETTE_MAX_BYTES);
    if (!bytes) return null;
    return await extractPaletteFromImageBytes(bytes.toString("base64"), mime);
  } catch {
    return null;
  }
}

export async function extractPaletteFromDomain(domain: string): Promise<PaletteColor[] | null> {
  const page = await fetchHomepage(domain);
  const cssTokens = page ? harvestCssColors(page.html, MAX_TOKENS) : [];
  const imageColors = page ? await brandImageColors(page.html, page.baseUrl) : null;

  // Brand-image hexes lead the token list (higher signal than CSS chrome), then CSS tokens.
  const tokens = [...new Set([...(imageColors ?? []).map((c) => c.hex), ...cssTokens])].slice(
    0,
    MAX_TOKENS,
  );
  if (!tokens.length && !page?.text) return null;

  const siteText = page?.text ? stripFenceDelimiters(page.text) : "(no website text available)";
  const raw = await generateText(
    renderPrompt("brand.curate_website_palette", {
      domain,
      color_tokens: tokens.join(", ") || "(none found)",
      site_text: siteText,
    }),
  );
  if (!raw) return null;
  const json = parseFirstJson(raw);
  if (!json || typeof json !== "object") return null;
  const colors = clampColors((json as Record<string, unknown>).palette);
  return colors.length ? colors : null;
}
