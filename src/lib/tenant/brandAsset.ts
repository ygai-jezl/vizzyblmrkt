import { randomUUID } from "node:crypto";
import { getApps, initializeApp, applicationDefault, type App } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";

/**
 * Private storage for tenant BRAND-GUIDELINE PDFs (Account → Brand), reusing the
 * org's only private bucket (EMAIL_ASSET_BUCKET). The PDF is NEVER served publicly —
 * it's read server-side only to run the AI brand-kit extraction. The object key has
 * THREE segments under a `brand/` prefix (`brand/{tenantId}/{file}`) so it can never
 * be matched by the public email-asset proxy's 3-segment regex (which has no prefix).
 * Only the FILENAME is stored on the tenant; the full key is reconstructed from the
 * SESSION's tenantId, so a request can only ever reach its own tenant's PDF.
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

/** 14MB raw cap: base64-inlining inflates ~4/3, so the Gemini extract request stays
 *  under its ~20MB inline limit (14MiB raw → ~18.7MB base64 + the prompt). */
export const MAX_BRAND_PDF_BYTES = 14 * 1024 * 1024;
/** A stored brand-pdf filename: `<uuid>.pdf` — no path separators / traversal. */
export const BRAND_PDF_FILENAME = /^[A-Za-z0-9-]+\.pdf$/;

/** Verify the real type from magic bytes (`%PDF`) — never trust the client mime. */
export function sniffPdf(bytes: Buffer): boolean {
  return (
    bytes.length >= 5 &&
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 && // F
    bytes[4] === 0x2d //   -
  );
}

function keyFor(tenantId: string, filename: string): string {
  return `brand/${tenantId}/${filename}`;
}

export type StoreBrandPdfResult =
  | { ok: true; filename: string }
  | { ok: false; reason: "no_asset_bucket" | "store_failed" | "bad_type" | "too_large" };

export async function storeBrandPdf(tenantId: string, bytes: Buffer): Promise<StoreBrandPdfResult> {
  if (bytes.length > MAX_BRAND_PDF_BYTES) return { ok: false, reason: "too_large" };
  if (!sniffPdf(bytes)) return { ok: false, reason: "bad_type" };
  const bucketName = process.env.EMAIL_ASSET_BUCKET;
  if (!bucketName) return { ok: false, reason: "no_asset_bucket" };
  const filename = `${randomUUID()}.pdf`;
  try {
    const file = getStorage(adminApp()).bucket(bucketName).file(keyFor(tenantId, filename));
    await file.save(bytes, {
      contentType: "application/pdf",
      resumable: false,
      metadata: { cacheControl: "private, max-age=86400" },
    });
    return { ok: true, filename };
  } catch (err) {
    console.warn("[brandAsset] upload failed:", err);
    return { ok: false, reason: "store_failed" };
  }
}

/** Read a stored brand PDF back for server-side extraction (never public). */
export async function readBrandPdf(tenantId: string, filename: string): Promise<Buffer | null> {
  if (!BRAND_PDF_FILENAME.test(filename)) return null;
  const bucketName = process.env.EMAIL_ASSET_BUCKET;
  if (!bucketName) return null;
  try {
    const file = getStorage(adminApp()).bucket(bucketName).file(keyFor(tenantId, filename));
    const [bytes] = await file.download();
    return bytes;
  } catch (err) {
    console.warn("[brandAsset] read failed:", err);
    return null;
  }
}
