import { safeFetch, readTextCapped, readBytesCapped } from "@/lib/security/ssrf";
import { readCachedFont, storeCachedFont } from "@/lib/tenant/brandFontStore";
import { fontInfo } from "./sfntInfo";

/**
 * A free Google family as TTF bytes for the image renderer. Google Fonts serves TTF to a request
 * without a browser user agent (checked 2026-10-19). Only fonts.gstatic.com addresses are taken,
 * up to 2 MB, and the file must read as a font. Cached in memory and in the bucket, so a family
 * is fetched once. Any failure gives null and the renderer moves to its next font.
 */

const MAX_FONT_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 5000;
const MEMORY_LIMIT = 24;
const memory = new Map<string, Buffer | null>();

export interface GoogleFontDeps {
  fetchCss: (url: string) => Promise<{ status: number; text: string } | null>;
  fetchFont: (url: string) => Promise<Buffer | null>;
  readCache: (key: string) => Promise<Buffer | null>;
  writeCache: (key: string, bytes: Buffer) => Promise<void>;
}

const defaultDeps: GoogleFontDeps = {
  async fetchCss(url) {
    try {
      const res = await safeFetch(url, { headers: { Accept: "text/css" } }, { timeoutMs: TIMEOUT_MS, maxRedirects: 0 });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return { status: res.status, text: "" };
      }
      return { status: res.status, text: await readTextCapped(res, 64 * 1024) };
    } catch {
      return null;
    }
  },
  async fetchFont(url) {
    try {
      const res = await safeFetch(url, {}, { timeoutMs: TIMEOUT_MS, maxRedirects: 0 });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return null;
      }
      return await readBytesCapped(res, MAX_FONT_BYTES);
    } catch {
      return null;
    }
  },
  readCache: readCachedFont,
  writeCache: storeCachedFont,
};

export function cacheKey(family: string, weight: number): string {
  const slug = family.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
  return `${slug}-${weight}.ttf`;
}

/** The first fonts.gstatic.com address in a Google Fonts stylesheet. */
export function gstaticUrl(css: string): string | null {
  const re = /url\(\s*['"]?(https:\/\/fonts\.gstatic\.com\/[^'")\s]+)['"]?\s*\)/i;
  const m = re.exec(css);
  if (!m) return null;
  try {
    const u = new URL(m[1]!);
    return u.protocol === "https:" && u.hostname === "fonts.gstatic.com" ? u.toString() : null;
  } catch {
    return null;
  }
}

export async function googleFontTtf(
  family: string,
  weight: 400 | 700,
  deps: GoogleFontDeps = defaultDeps,
): Promise<Buffer | null> {
  const clean = family.replace(/[^A-Za-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const key = cacheKey(clean, weight);
  if (memory.has(key)) return memory.get(key)!;

  const remember = (v: Buffer | null) => {
    if (memory.size >= MEMORY_LIMIT) memory.delete(memory.keys().next().value!);
    memory.set(key, v);
    return v;
  };

  const cached = await deps.readCache(key).catch(() => null);
  if (cached && fontInfo(cached)) return remember(cached);

  const name = encodeURIComponent(clean).replace(/%20/g, "+");
  // Ask for the weight; a family without it answers 400, so ask for its default instead.
  let css = await deps.fetchCss(`https://fonts.googleapis.com/css2?family=${name}:wght@${weight}`);
  if (css && css.status === 400) css = await deps.fetchCss(`https://fonts.googleapis.com/css2?family=${name}`);
  // Don't remember a network failure: the next render may get through.
  if (!css) return null;
  const url = css.status === 200 ? gstaticUrl(css.text) : null;
  if (!url) return remember(null);
  const bytes = await deps.fetchFont(url);
  if (!bytes || !fontInfo(bytes)) return null;
  await deps.writeCache(key, bytes).catch(() => {});
  return remember(bytes);
}

/** Tests only. */
export function clearGoogleFontMemory(): void {
  memory.clear();
}
