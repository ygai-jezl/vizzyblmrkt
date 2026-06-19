import { randomUUID } from "node:crypto";
import {
  getApps,
  initializeApp,
  applicationDefault,
  type App,
} from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";
import type { GeneratedImage } from "./gemini";

/**
 * Persists Agent 3's generated hero images to a PRIVATE GCS bucket and reads
 * them back for the public email-asset proxy route.
 *
 * The org enforces uniform bucket-level access + domain-restricted sharing, so
 * objects can't be made publicly readable (no ACLs, no `allUsers` IAM grant).
 * Recipients therefore fetch images through `/api/email-asset/<path>`, which
 * streams from here using the runtime service account. Best-effort: a missing
 * EMAIL_ASSET_BUCKET or a failed upload degrades gracefully so the email is
 * still composed/sent (without the image).
 */
function adminApp(): App {
  const existing = getApps()[0];
  if (existing) return existing;
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    return initializeApp({
      projectId: process.env.GOOGLE_CLOUD_PROJECT ?? "demo-vizzybl",
    });
  }
  return initializeApp({
    credential: applicationDefault(),
    projectId: process.env.GOOGLE_CLOUD_PROJECT,
  });
}

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

const CONTENT_TYPE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export type StoreImageResult =
  | { ok: true; path: string }
  | { ok: false; reason: "no_asset_bucket" | "store_failed" };

/**
 * Uploads a generated image and returns its bucket-relative object path
 * (`<tenantId>/<campaignId>/<uuid>.<ext>`). The bucket is dedicated to email
 * assets, so no extra key prefix is needed. The path is what the proxy route
 * serves; callers turn it into an absolute URL.
 */
export async function storeEmailImage(
  tenantId: string,
  campaignId: string,
  img: GeneratedImage,
): Promise<StoreImageResult> {
  const bucketName = process.env.EMAIL_ASSET_BUCKET;
  if (!bucketName) return { ok: false, reason: "no_asset_bucket" };
  const path = `${tenantId}/${campaignId}/${randomUUID()}.${
    EXT[img.mimeType] ?? "png"
  }`;
  try {
    const file = getStorage(adminApp()).bucket(bucketName).file(path);
    await file.save(img.bytes, {
      contentType: img.mimeType,
      resumable: false,
      metadata: { cacheControl: "public,max-age=31536000,immutable" },
    });
    return { ok: true, path };
  } catch (err) {
    console.warn("[imageStore] upload failed:", err);
    return { ok: false, reason: "store_failed" };
  }
}

export interface EmailAsset {
  bytes: Buffer;
  contentType: string;
}

/**
 * Reads a stored email asset back for the public `/api/email-asset` proxy.
 * Returns null when the bucket is unconfigured or the object is missing /
 * unreadable (the route turns null into a 404).
 */
export async function readEmailAsset(path: string): Promise<EmailAsset | null> {
  const bucketName = process.env.EMAIL_ASSET_BUCKET;
  if (!bucketName) return null;
  try {
    const file = getStorage(adminApp()).bucket(bucketName).file(path);
    const [bytes] = await file.download();
    return { bytes, contentType: contentTypeForPath(path) };
  } catch (err) {
    // download() throws on 404 / permission errors — treat all as "missing".
    console.warn("[imageStore] read failed:", err);
    return null;
  }
}

function contentTypeForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPE[ext] ?? "application/octet-stream";
}
