import { randomUUID } from "node:crypto";
import {
  getApps,
  initializeApp,
  applicationDefault,
  type App,
} from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";

/**
 * Private storage for Idea Board SCREENSHOTS, reusing the org's only private
 * bucket (EMAIL_ASSET_BUCKET — the SA already holds objectCreator/objectViewer).
 *
 * Unlike email hero images (served by the PUBLIC /api/email-asset proxy), these
 * are private: served only through the AUTHENTICATED workspace asset proxy. The
 * object key has FOUR segments (`workspace/{tenantId}/{workspaceId}/{file}`) so it
 * can never be matched by the public email-asset route's 3-segment regex.
 *
 * The stored reference is just the FILENAME; the full key is always reconstructed
 * server-side from the SESSION's tenantId — so a request can only ever reach its
 * own tenant's objects.
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

/** Sniffed-mime → file extension. Exported so the brand-logo store shares one mapping. */
export const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};
/** File extension → content-type (for serving). Exported alongside EXT. */
export const CONTENT_TYPE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

export const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024; // 8 MB
/** A stored screenshot filename: `<uuid>.<ext>` — no path separators / traversal. */
export const SCREENSHOT_FILENAME = /^[A-Za-z0-9-]+\.(png|jpe?g|webp)$/;

export function isAllowedScreenshotType(mime: string): boolean {
  return ALLOWED_MIME.has(mime);
}

/** Sniff the real image type from magic bytes — never trust the client-declared
 *  content-type. Returns the verified mime, or null if not a PNG/JPEG/WebP. */
export function sniffImageMime(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function keyFor(tenantId: string, workspaceId: string, filename: string): string {
  return `workspace/${tenantId}/${workspaceId}/${filename}`;
}

export type StoreResult =
  | { ok: true; filename: string }
  | { ok: false; reason: "no_asset_bucket" | "store_failed" | "bad_type" | "too_large" };

export async function storeWorkspaceImage(
  tenantId: string,
  workspaceId: string,
  bytes: Buffer,
  mimeType: string,
): Promise<StoreResult> {
  if (bytes.length > MAX_SCREENSHOT_BYTES) return { ok: false, reason: "too_large" };
  // Trust the SNIFFED type, not the client-declared content-type.
  const sniffed = sniffImageMime(bytes);
  if (!sniffed || !isAllowedScreenshotType(mimeType)) return { ok: false, reason: "bad_type" };
  const bucketName = process.env.EMAIL_ASSET_BUCKET;
  if (!bucketName) return { ok: false, reason: "no_asset_bucket" };
  const filename = `${randomUUID()}.${EXT[sniffed] ?? "png"}`;
  try {
    const file = getStorage(adminApp()).bucket(bucketName).file(keyFor(tenantId, workspaceId, filename));
    await file.save(bytes, {
      contentType: sniffed,
      resumable: false,
      metadata: { cacheControl: "private, max-age=86400" },
    });
    return { ok: true, filename };
  } catch (err) {
    console.warn("[workspaceAsset] upload failed:", err);
    return { ok: false, reason: "store_failed" };
  }
}

export interface WorkspaceAsset {
  bytes: Buffer;
  contentType: string;
}

export async function readWorkspaceAsset(
  tenantId: string,
  workspaceId: string,
  filename: string,
): Promise<WorkspaceAsset | null> {
  if (!SCREENSHOT_FILENAME.test(filename)) return null;
  const bucketName = process.env.EMAIL_ASSET_BUCKET;
  if (!bucketName) return null;
  try {
    const file = getStorage(adminApp()).bucket(bucketName).file(keyFor(tenantId, workspaceId, filename));
    const [bytes] = await file.download();
    const ext = filename.split(".").pop()?.toLowerCase() ?? "";
    return { bytes, contentType: CONTENT_TYPE[ext] ?? "application/octet-stream" };
  } catch (err) {
    console.warn("[workspaceAsset] read failed:", err);
    return null;
  }
}

export async function deleteWorkspaceAsset(
  tenantId: string,
  workspaceId: string,
  filename: string,
): Promise<void> {
  if (!SCREENSHOT_FILENAME.test(filename)) return;
  const bucketName = process.env.EMAIL_ASSET_BUCKET;
  if (!bucketName) return;
  try {
    await getStorage(adminApp()).bucket(bucketName).file(keyFor(tenantId, workspaceId, filename)).delete();
  } catch {
    /* best-effort */
  }
}
