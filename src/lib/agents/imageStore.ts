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
 * Persists Agent 3's generated hero images to GCS and returns a public URL email
 * clients can fetch. Best-effort: returns null when no EMAIL_ASSET_BUCKET is
 * configured or the upload fails — the email is still composed/sent without it.
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

export async function storeEmailImage(
  tenantId: string,
  campaignId: string,
  img: GeneratedImage,
): Promise<string | null> {
  const bucketName = process.env.EMAIL_ASSET_BUCKET;
  if (!bucketName) return null;
  try {
    const bucket = getStorage(adminApp()).bucket(bucketName);
    const path = `email-assets/${tenantId}/${campaignId}/${randomUUID()}.${
      EXT[img.mimeType] ?? "png"
    }`;
    const file = bucket.file(path);
    await file.save(img.bytes, {
      contentType: img.mimeType,
      resumable: false,
      metadata: { cacheControl: "public,max-age=31536000" },
    });
    // Public-read so email clients can load it; ignored if the bucket uses
    // uniform access (operator grants allUsers:objectViewer at the bucket level).
    await file.makePublic().catch(() => {});
    return `https://storage.googleapis.com/${bucketName}/${path}`;
  } catch (err) {
    console.warn("[imageStore] upload failed:", err);
    return null;
  }
}
