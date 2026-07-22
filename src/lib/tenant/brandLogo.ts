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

/**
 * Private storage for tenant BRAND LOGOS (Brand Kit → Logos), reusing the org's only
 * private bucket (EMAIL_ASSET_BUCKET — the SA already holds objectCreator/objectViewer).
 *
 * Logos are brand-global (NOT workspace-scoped): the object key has FOUR segments under a
 * `brand/.../logos/` prefix (`brand/{tenantId}/logos/{file}`) so it can never be matched
 * by the public email-asset proxy's 3-segment regex, and the fixed `logos/` segment plus
 * the image-only filename regex keep the logo proxy away from the sibling brand-guideline
 * PDFs (`brand/{tenantId}/{uuid}.pdf`, served by nothing). Only the FILENAME is stored on
 * the doc; the full key is reconstructed from the tenantId, so a request can only ever
 * reach its own tenant's logos. Type is trusted from the magic-byte sniff, not the client.
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

/** Logos share the 8 MB image cap. */
export const MAX_LOGO_BYTES = MAX_SCREENSHOT_BYTES;
/** A stored logo filename: `<uuid>.<ext>` — identical allowed set to screenshots, so we
 *  reuse the one anchored regex (no `/` or `..`) rather than let two copies drift. */
export const LOGO_FILENAME = SCREENSHOT_FILENAME;

function keyFor(tenantId: string, filename: string): string {
  return `brand/${tenantId}/logos/${filename}`;
}

export type StoreLogoResult =
  | { ok: true; filename: string; mimeType: string }
  | { ok: false; reason: "no_asset_bucket" | "store_failed" | "bad_type" | "too_large" };

export async function storeBrandLogo(
  tenantId: string,
  bytes: Buffer,
  mimeType: string,
): Promise<StoreLogoResult> {
  if (bytes.length > MAX_LOGO_BYTES) return { ok: false, reason: "too_large" };
  // Trust the SNIFFED type, not the client-declared content-type.
  const sniffed = sniffImageMime(bytes);
  if (!sniffed || !isAllowedScreenshotType(mimeType)) return { ok: false, reason: "bad_type" };
  const bucketName = process.env.EMAIL_ASSET_BUCKET;
  if (!bucketName) return { ok: false, reason: "no_asset_bucket" };
  const filename = `${randomUUID()}.${IMAGE_EXT_BY_MIME[sniffed] ?? "png"}`;
  try {
    const file = getStorage(adminApp()).bucket(bucketName).file(keyFor(tenantId, filename));
    await file.save(bytes, {
      contentType: sniffed,
      resumable: false,
      metadata: { cacheControl: "public, max-age=31536000, immutable" },
    });
    return { ok: true, filename, mimeType: sniffed };
  } catch (err) {
    console.warn("[brandLogo] upload failed:", err);
    return { ok: false, reason: "store_failed" };
  }
}

export interface BrandLogoBytes {
  bytes: Buffer;
  contentType: string;
}

export async function readBrandLogo(
  tenantId: string,
  filename: string,
): Promise<BrandLogoBytes | null> {
  if (!LOGO_FILENAME.test(filename)) return null;
  const bucketName = process.env.EMAIL_ASSET_BUCKET;
  if (!bucketName) return null;
  try {
    const file = getStorage(adminApp()).bucket(bucketName).file(keyFor(tenantId, filename));
    const [bytes] = await file.download();
    const ext = filename.split(".").pop()?.toLowerCase() ?? "";
    return { bytes, contentType: IMAGE_MIME_BY_EXT[ext] ?? "application/octet-stream" };
  } catch (err) {
    console.warn("[brandLogo] read failed:", err);
    return null;
  }
}

export async function deleteBrandLogo(tenantId: string, filename: string): Promise<void> {
  if (!LOGO_FILENAME.test(filename)) return;
  const bucketName = process.env.EMAIL_ASSET_BUCKET;
  if (!bucketName) return;
  try {
    await getStorage(adminApp()).bucket(bucketName).file(keyFor(tenantId, filename)).delete();
  } catch {
    /* best-effort */
  }
}
