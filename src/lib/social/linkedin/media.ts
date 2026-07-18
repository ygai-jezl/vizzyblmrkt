/**
 * LinkedIn image upload — the 2-step "images" dance required before an image can be
 * attached to a Posts-API post. Compliant, sanctioned media upload for organic posts.
 *
 *   1. POST /rest/images?action=initializeUpload  → { uploadUrl, image: urn:li:image:… }
 *   2. PUT the raw bytes to uploadUrl (Bearer auth)
 *
 * The returned `urn:li:image:…` is what the caller puts in the post body's
 * `content.media.id` (see client.ts). Pure over an injectable fetch → unit-testable
 * with no network. Fail-distinct (init vs upload vs timeout) so the caller can decide
 * to fall back to a text-only post rather than parking the whole publish over an image.
 */

const LINKEDIN_IMAGES_ENDPOINT = "https://api.linkedin.com/rest/images?action=initializeUpload";
const DEFAULT_LINKEDIN_VERSION = process.env.LINKEDIN_API_VERSION ?? "202606";
/** Wall-time budget for the WHOLE upload (init + PUT). Kept well under the worker
 *  lease (5min) so it composes with the post publish (60s) inside one claim. */
const UPLOAD_BUDGET_MS = 60_000;

export interface UploadLinkedInImageInput {
  /** The post author who will own the image — `urn:li:organization:{id}` (Page) or
   *  `urn:li:person:{id}` (member). Must match the post's author. */
  ownerUrn: string;
  /** The raw image bytes (e.g. from readWorkspaceAsset). */
  bytes: Uint8Array;
  /** Member/CM OAuth 2.0 access token (w_organization_social / w_member_social). */
  accessToken: string;
  /** Optional MIME type for the binary PUT (LinkedIn also infers from the bytes). */
  contentType?: string;
}

export type UploadLinkedInImageResult =
  | { ok: true; imageUrn: string }
  | { ok: false; reason: string };

export interface UploadLinkedInImageDeps {
  fetch?: typeof fetch;
  endpoint?: string;
  version?: string;
  timeoutMs?: number;
}

type InitObj = { value?: { uploadUrl?: unknown; image?: unknown } };

export async function uploadLinkedInImage(
  input: UploadLinkedInImageInput,
  deps: UploadLinkedInImageDeps = {},
): Promise<UploadLinkedInImageResult> {
  if (!input.accessToken) return { ok: false, reason: "not_connected" };
  if (!input.ownerUrn) return { ok: false, reason: "no_owner" };
  if (!input.bytes || input.bytes.byteLength === 0) return { ok: false, reason: "empty" };

  const doFetch = deps.fetch ?? fetch;
  const endpoint = deps.endpoint ?? LINKEDIN_IMAGES_ENDPOINT;
  const version = deps.version ?? DEFAULT_LINKEDIN_VERSION;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? UPLOAD_BUDGET_MS);

  try {
    // ── Step 1: initializeUpload → get the one-shot upload URL + the image URN.
    let initRes: Response;
    try {
      initRes = await doFetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.accessToken}`,
          "content-type": "application/json",
          "linkedin-version": version,
          "x-restli-protocol-version": "2.0.0",
        },
        body: JSON.stringify({ initializeUploadRequest: { owner: input.ownerUrn } }),
        signal: controller.signal,
      });
    } catch {
      return { ok: false, reason: controller.signal.aborted ? "timeout" : "network_error" };
    }
    if (!initRes.ok) return { ok: false, reason: `li_img_init_${initRes.status}` };

    const init = ((await initRes.json().catch(() => null)) as InitObj | null)?.value ?? {};
    const uploadUrl = typeof init.uploadUrl === "string" ? init.uploadUrl : "";
    const imageUrn = typeof init.image === "string" ? init.image : "";
    if (!uploadUrl || !imageUrn) return { ok: false, reason: "no_upload_url" };

    // ── Step 2: PUT the raw bytes to the returned upload URL.
    let putRes: Response;
    try {
      putRes = await doFetch(uploadUrl, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${input.accessToken}`,
          "content-type": input.contentType ?? "application/octet-stream",
        },
        // Node/undici fetch accepts a Uint8Array body at runtime; the DOM `BodyInit`
        // lib type (post-TS5.7) rejects Uint8Array<ArrayBufferLike>, so cast — the bytes
        // are a Buffer from object storage, never a SharedArrayBuffer-backed view.
        body: input.bytes as unknown as BodyInit,
        signal: controller.signal,
      });
    } catch {
      return { ok: false, reason: controller.signal.aborted ? "timeout" : "network_error" };
    }
    if (!putRes.ok) return { ok: false, reason: `li_img_upload_${putRes.status}` };

    // The image URN is usable immediately for a post reference (upload is synchronous
    // for images; only video needs a processing poll).
    return { ok: true, imageUrn };
  } finally {
    clearTimeout(timer);
  }
}
