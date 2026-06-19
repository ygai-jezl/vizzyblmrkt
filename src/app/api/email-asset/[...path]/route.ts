import { readEmailAsset } from "@/lib/agents/imageStore";

export const runtime = "nodejs";

/**
 * Public, unauthenticated proxy for Agent 3's hero images.
 *
 * The org forbids public GCS objects (enforced uniform bucket-level access +
 * domain-restricted sharing), so email images live in a PRIVATE bucket and are
 * served here, streamed via the runtime service account. Object keys are
 * `<tenantId>/<campaignId>/<uuid>.<ext>` (see imageStore.ts) — the random uuid
 * is the only secret, exactly as the previous public-URL design relied on.
 */
const SEGMENT = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9]+)?$/;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  // Accept only the exact <tenant>/<campaign>/<file> shape with safe segments
  // (no traversal, no nested keys).
  if (
    !Array.isArray(path) ||
    path.length !== 3 ||
    path.some((s) => s === "." || s === ".." || !SEGMENT.test(s))
  ) {
    return new Response("Not found", { status: 404 });
  }

  const asset = await readEmailAsset(path.join("/"));
  if (!asset) return new Response("Not found", { status: 404 });

  return new Response(new Uint8Array(asset.bytes), {
    status: 200,
    headers: {
      "Content-Type": asset.contentType,
      "Content-Length": String(asset.bytes.length),
      // Immutable: object keys are content-addressed by uuid, never reused.
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
