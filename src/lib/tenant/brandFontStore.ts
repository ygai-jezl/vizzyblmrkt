import { randomUUID } from "node:crypto";
import { getApps, initializeApp, applicationDefault, type App } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";

/**
 * Private storage for tenant BRAND FONT FILES (Brand Kit → Fonts → "Upload a font"), reusing the
 * org's only private bucket (EMAIL_ASSET_BUCKET). Fonts are brand-global: the object key has FOUR
 * segments under a `brand/.../fonts/` prefix (`brand/{tenantId}/fonts/{file}`) so it can never be
 * matched by the public email-asset proxy's 3-segment regex, and the fixed `fonts/` segment plus
 * the font-only filename regex keep the font proxy away from the sibling logos / brand PDFs. Only
 * the FILENAME is stored on the doc; the full key is reconstructed from the tenantId. Type is
 * trusted from the magic-byte sniff, not the client. Served publicly (uuid credential) so an
 * `@font-face` rule can load the file for in-app preview.
 */
function adminApp(): App {
  const existing = getApps()[0];
  if (existing) return existing;
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    return initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT ?? "demo-vizzybl" });
  }
  return initializeApp({
    credential: applicationDefault(),
    projectId: process.env.GOOGLE_CLOUD_PROJECT,
  });
}

/** Font files are small; 5 MB is generous for a single weight. */
export const MAX_FONT_BYTES = 5 * 1024 * 1024;

/** Sniffed font-type → file extension. */
const EXT_BY_MIME: Record<string, string> = {
  "font/woff2": "woff2",
  "font/woff": "woff",
  "font/ttf": "ttf",
  "font/otf": "otf",
};
/** File extension → content-type (for serving). */
const MIME_BY_EXT: Record<string, string> = {
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
};

/** A stored font filename: `<uuid>.<ext>` — no path separators / traversal. */
export const FONT_FILENAME = /^[A-Za-z0-9-]+\.(woff2|woff|ttf|otf)$/;

/**
 * Sniff the real font type from magic bytes — never trust the client-declared content-type.
 * WOFF2 = `wOF2`, WOFF = `wOFF`, OTF = `OTTO`, TTF = `\0\1\0\0` or `true`. Returns the verified
 * mime, or null if it isn't a recognised font container.
 */
export function sniffFontMime(bytes: Buffer): string | null {
  if (bytes.length < 4) return null;
  const tag = bytes.toString("ascii", 0, 4);
  if (tag === "wOF2") return "font/woff2";
  if (tag === "wOFF") return "font/woff";
  if (tag === "OTTO") return "font/otf";
  if (tag === "true" || tag === "ttcf") return "font/ttf";
  // TrueType sfnt version 0x00010000
  if (bytes[0] === 0x00 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) {
    return "font/ttf";
  }
  return null;
}

function keyFor(tenantId: string, filename: string): string {
  return `brand/${tenantId}/fonts/${filename}`;
}

export type StoreFontResult =
  | { ok: true; filename: string; mimeType: string }
  | { ok: false; reason: "no_asset_bucket" | "store_failed" | "bad_type" | "too_large" };

export async function storeBrandFont(tenantId: string, bytes: Buffer): Promise<StoreFontResult> {
  if (bytes.length > MAX_FONT_BYTES) return { ok: false, reason: "too_large" };
  const sniffed = sniffFontMime(bytes);
  if (!sniffed) return { ok: false, reason: "bad_type" };
  const bucketName = process.env.EMAIL_ASSET_BUCKET;
  if (!bucketName) return { ok: false, reason: "no_asset_bucket" };
  const filename = `${randomUUID()}.${EXT_BY_MIME[sniffed] ?? "woff2"}`;
  try {
    const file = getStorage(adminApp()).bucket(bucketName).file(keyFor(tenantId, filename));
    await file.save(bytes, {
      contentType: sniffed,
      resumable: false,
      metadata: { cacheControl: "public, max-age=31536000, immutable" },
    });
    return { ok: true, filename, mimeType: sniffed };
  } catch (err) {
    console.warn("[brandFont] upload failed:", err);
    return { ok: false, reason: "store_failed" };
  }
}

export interface BrandFontBytes {
  bytes: Buffer;
  contentType: string;
}

export async function readBrandFont(
  tenantId: string,
  filename: string,
): Promise<BrandFontBytes | null> {
  if (!FONT_FILENAME.test(filename)) return null;
  const bucketName = process.env.EMAIL_ASSET_BUCKET;
  if (!bucketName) return null;
  try {
    const file = getStorage(adminApp()).bucket(bucketName).file(keyFor(tenantId, filename));
    const [bytes] = await file.download();
    const ext = filename.split(".").pop()?.toLowerCase() ?? "";
    return { bytes, contentType: MIME_BY_EXT[ext] ?? "application/octet-stream" };
  } catch (err) {
    console.warn("[brandFont] read failed:", err);
    return null;
  }
}

export async function deleteBrandFontBytes(tenantId: string, filename: string): Promise<void> {
  if (!FONT_FILENAME.test(filename)) return;
  const bucketName = process.env.EMAIL_ASSET_BUCKET;
  if (!bucketName) return;
  try {
    await getStorage(adminApp()).bucket(bucketName).file(keyFor(tenantId, filename)).delete();
  } catch {
    /* best-effort */
  }
}
