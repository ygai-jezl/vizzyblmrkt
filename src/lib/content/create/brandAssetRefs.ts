import { listBrandAssets } from "@/lib/admin/brandAssets";
import { readBrandAsset } from "@/lib/tenant/brandAssetStore";
import { EBOOK_IMAGE_INLINE_MAX_BYTES } from "@/lib/content/create/ebook";
import { isBrandAssetRefsEnabled } from "@/lib/content/brandKit";
import type { TenantContext } from "@/lib/tenant/types";
import type { BrandAssetCategory } from "@/lib/types/brandAsset";

/**
 * Deep reference integration for the Brand Kit → Icons / Graphics libraries: fetch the tenant's
 * uploaded brand ASSETS as visual reference images to hand to the image model, so generated brand
 * imagery echoes the brand's own iconography/graphic style (not just a text directive). Mirrors
 * retrieveExemplarImages (the brand-style exemplar loop). Fail-soft: any problem returns [] and
 * generation proceeds without them. Gated by BRAND_ASSET_REFS_ENABLED.
 */
export interface RetrievedRefImage {
  base64: string;
  mimeType: string;
}

/** Cap on brand-asset references per generation (shares the model's image budget with exemplars). */
export const MAX_ASSET_REFS = 3;

export async function retrieveBrandAssetRefs(req: {
  ctx: TenantContext;
  categories?: BrandAssetCategory[];
  limit?: number;
}): Promise<RetrievedRefImage[]> {
  if (!isBrandAssetRefsEnabled()) return [];
  const categories = req.categories ?? ["icon", "graphic"];
  const limit = Math.min(req.limit ?? MAX_ASSET_REFS, MAX_ASSET_REFS);
  try {
    const groups = await Promise.all(
      categories.map((c) => listBrandAssets(req.ctx, c).catch(() => [])),
    );
    // Newest-first across all requested categories (createdAt is an ISO string → lexical sort).
    // localeCompare keeps the comparator antisymmetric (returns 0 for equal timestamps).
    const rows = groups.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (rows.length === 0) return [];

    const images: RetrievedRefImage[] = [];
    for (const a of rows) {
      const asset = await readBrandAsset(req.ctx.tenantId, a.category, a.filename).catch(() => null);
      if (!asset) continue;
      if (asset.bytes.length > EBOOK_IMAGE_INLINE_MAX_BYTES) continue;
      images.push({ base64: asset.bytes.toString("base64"), mimeType: asset.contentType });
      if (images.length >= limit) break;
    }
    return images;
  } catch (err) {
    console.warn("[brandAssetRefs] retrieveBrandAssetRefs failed:", err);
    return [];
  }
}

/**
 * The directive appended when brand-asset references are attached, so the model treats the trailing
 * images as the brand's OWN icons/graphics — echoing their style/motifs, never copying them
 * verbatim, placing them as logos, or reproducing any text in them.
 */
export const BRAND_ASSET_REF_DIRECTIVE =
  "The final image(s) attached are the brand's OWN icons/graphics: echo their visual style, " +
  "shapes, colour, and motifs where relevant. Do NOT copy them verbatim, place them as a logo, " +
  "or reproduce any text/watermarks in them.";
