import { readBrandLogo } from "@/lib/tenant/brandLogo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PUBLIC proxy for tenant brand LOGOS. Logos are inherently public brand assets, and the
 * primary logo must load in recipient inboxes (no session), so — like email hero images —
 * the read credential is the UNGUESSABLE uuid filename, not auth. The key is reconstructed
 * as `brand/{tenantId}/logos/{filename}` from exactly TWO safe segments: the fixed `logos/`
 * segment + the image-only filename regex (enforced in readBrandLogo) guarantee it can
 * never reach the sibling brand-guideline PDFs (`brand/{tenantId}/{uuid}.pdf`) or the
 * 4-segment private workspace assets. Streams bytes with the stored content-type.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  if (!Array.isArray(path) || path.length !== 2) {
    return new Response("Not found", { status: 404 });
  }
  const [tenantId, filename] = path;
  if (!tenantId || !filename) {
    return new Response("Not found", { status: 404 });
  }
  // Charset-guard the tenant segment (the filename is validated inside readBrandLogo);
  // together they prevent any path traversal into the reconstructed key.
  if (!/^[A-Za-z0-9_-]+$/.test(tenantId)) {
    return new Response("Not found", { status: 404 });
  }
  const asset = await readBrandLogo(tenantId, filename);
  if (!asset) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(asset.bytes), {
    status: 200,
    headers: {
      "Content-Type": asset.contentType,
      "Content-Length": String(asset.bytes.length),
      "Cache-Control": "public, max-age=31536000, immutable",
      // Defence-in-depth: the bytes are magic-byte-verified images, but never let a browser
      // content-sniff this public, user-uploaded stream into anything executable.
      "X-Content-Type-Options": "nosniff",
    },
  });
}
