import { readBrandFont } from "@/lib/tenant/brandFontStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PUBLIC proxy for tenant brand FONT files. Fonts are inherently public brand assets; the read
 * credential is the UNGUESSABLE uuid filename, not auth (so an `@font-face` rule can load them for
 * in-app preview). The key is reconstructed as `brand/{tenantId}/fonts/{filename}` from exactly TWO
 * safe segments: the fixed `fonts/` segment (in readBrandFont) + the font-only filename regex
 * guarantee it can never reach the sibling logos/assets/brand PDFs. Streams bytes with the stored
 * content-type.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  if (!Array.isArray(path) || path.length !== 2) {
    return new Response("Not found", { status: 404 });
  }
  const [tenantId, filename] = path;
  if (!tenantId || !filename) {
    return new Response("Not found", { status: 404 });
  }
  // Charset-guard the tenant segment (the filename is validated inside readBrandFont);
  // together they prevent any path traversal into the reconstructed key.
  if (!/^[A-Za-z0-9_-]+$/.test(tenantId)) {
    return new Response("Not found", { status: 404 });
  }
  const asset = await readBrandFont(tenantId, filename);
  if (!asset) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(asset.bytes), {
    status: 200,
    headers: {
      "Content-Type": asset.contentType,
      "Content-Length": String(asset.bytes.length),
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
