import { randomUUID } from "node:crypto";
import { getApps, initializeApp, applicationDefault, type App } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";
import {
  EXT as IMAGE_EXT_BY_MIME,
  CONTENT_TYPE as IMAGE_MIME_BY_EXT,
  MAX_SCREENSHOT_BYTES,
  SCREENSHOT_FILENAME,
  isAllowedScreenshotType,
  sniffImageMime,
} from "@/lib/workspace/assetStore";
import type { BrandAssetCategory } from "@/lib/types/brandAsset";

/**
 * Private storage for tenant BRAND ASSETS — ICONS + GRAPHICS (Brand Kit → Icons / Graphics),
 * reusing the org's only private bucket (EMAIL_ASSET_BUCKET). Assets are brand-global: the object
 * key has FOUR segments under a `brand/.../{category}s/` prefix (`brand/{tenantId}/icons/{file}`
 * or `.../graphics/{file}`) so it can never be matched by the public email-asset proxy's
 * 3-segment regex, and the fixed category segment plus the image-only filename regex keep the
 * asset proxy away from the sibling logos / fonts / brand PDFs. Only the FILENAME is stored on the
 * doc; the full key is reconstructed from the tenantId + category. Raster-only (PNG/JPG/WebP) so
 * the bytes are directly ingestible by the image model. Type trusted from the magic-byte sniff.
 *
 * NOT the same as `src/lib/tenant/brandAsset.ts` (the brand-guideline PDF store).
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

/** Assets share the 8 MB image cap. */
export const MAX_ASSET_BYTES = MAX_SCREENSHOT_BYTES;
/** A stored asset filename: `<uuid>.<ext>` — reuse the anchored screenshot regex (no `/`/`..`). */
export const ASSET_FILENAME = SCREENSHOT_FILENAME;

/** The GCS sub-prefix per category (`icons/`, `graphics/`) — pluralised for readability. */
function segmentFor(category: BrandAssetCategory): string {
  return `${category}s`;
}

function keyFor(tenantId: string, category: BrandAssetCategory, filename: string): string {
  return `brand/${tenantId}/${segmentFor(category)}/${filename}`;
}

export type StoreAssetResult =
  | { ok: true; filename: string; mimeType: string }
  | { ok: false; reason: "no_asset_bucket" | "store_failed" | "bad_type" | "too_large" };

export async function storeBrandAsset(
  tenantId: string,
  category: BrandAssetCategory,
  bytes: Buffer,
  mimeType: string,
): Promise<StoreAssetResult> {
  if (bytes.length > MAX_ASSET_BYTES) return { ok: false, reason: "too_large" };
  // Trust the SNIFFED type, not the client-declared content-type.
  const sniffed = sniffImageMime(bytes);
  if (!sniffed || !isAllowedScreenshotType(mimeType)) return { ok: false, reason: "bad_type" };
  const bucketName = process.env.EMAIL_ASSET_BUCKET;
  if (!bucketName) return { ok: false, reason: "no_asset_bucket" };
  const filename = `${randomUUID()}.${IMAGE_EXT_BY_MIME[sniffed] ?? "png"}`;
  try {
    const file = getStorage(adminApp())
      .bucket(bucketName)
      .file(keyFor(tenantId, category, filename));
    await file.save(bytes, {
      contentType: sniffed,
      resumable: false,
      metadata: { cacheControl: "public, max-age=31536000, immutable" },
    });
    return { ok: true, filename, mimeType: sniffed };
  } catch (err) {
    console.warn("[brandAsset] upload failed:", err);
    return { ok: false, reason: "store_failed" };
  }
}

export interface BrandAssetBytes {
  bytes: Buffer;
  contentType: string;
}

export async function readBrandAsset(
  tenantId: string,
  category: BrandAssetCategory,
  filename: string,
): Promise<BrandAssetBytes | null> {
  if (!ASSET_FILENAME.test(filename)) return null;
  const bucketName = process.env.EMAIL_ASSET_BUCKET;
  if (!bucketName) return null;
  try {
    const file = getStorage(adminApp())
      .bucket(bucketName)
      .file(keyFor(tenantId, category, filename));
    const [bytes] = await file.download();
    const ext = filename.split(".").pop()?.toLowerCase() ?? "";
    return { bytes, contentType: IMAGE_MIME_BY_EXT[ext] ?? "application/octet-stream" };
  } catch (err) {
    console.warn("[brandAsset] read failed:", err);
    return null;
  }
}

export async function deleteBrandAssetBytes(
  tenantId: string,
  category: BrandAssetCategory,
  filename: string,
): Promise<void> {
  if (!ASSET_FILENAME.test(filename)) return;
  const bucketName = process.env.EMAIL_ASSET_BUCKET;
  if (!bucketName) return;
  try {
    await getStorage(adminApp())
      .bucket(bucketName)
      .file(keyFor(tenantId, category, filename))
      .delete();
  } catch {
    /* best-effort */
  }
}
