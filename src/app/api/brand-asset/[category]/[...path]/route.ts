import { readBrandAsset } from "@/lib/tenant/brandAssetStore";
import { BrandAssetCategorySchema } from "@/lib/types/brandAsset";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PUBLIC proxy for tenant brand ASSETS (icons/graphics). Like brand logos, the read credential is
 * the UNGUESSABLE uuid filename, not auth. The key is reconstructed as
 * `brand/{tenantId}/{category}s/{filename}` from a validated `category` enum + exactly TWO safe
 * path segments (tenantId charset-guarded + the image-only filename regex enforced inside
 * readBrandAsset) — so it can never traverse to the sibling logos/fonts or the private brand PDFs.
 * Streams bytes with the stored content-type.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ category: string; path: string[] }> },
) {
  const { category, path } = await params;
  const parsedCategory = BrandAssetCategorySchema.safeParse(category);
  if (!parsedCategory.success) return new Response("Not found", { status: 404 });
  if (!Array.isArray(path) || path.length !== 2) {
    return new Response("Not found", { status: 404 });
  }
  const [tenantId, filename] = path;
  if (!tenantId || !filename) {
    return new Response("Not found", { status: 404 });
  }
  if (!/^[A-Za-z0-9_-]+$/.test(tenantId)) {
    return new Response("Not found", { status: 404 });
  }
  const asset = await readBrandAsset(tenantId, parsedCategory.data, filename);
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
