import { z } from "zod";

/**
 * A tenant's uploaded brand ASSET — an ICON or GRAPHIC (Brand Kit → Icons / Graphics). Icons and
 * graphics are structurally identical raster assets, so they share ONE collection discriminated
 * by `category`. Like brand logos, they are BRAND-GLOBAL: the bytes live at a tenant-level GCS
 * key (`brand/{tenantId}/{category}s/{uuid}.{ext}`) and are served by the PUBLIC /api/brand-asset
 * proxy (unguessable-uuid credential). Raster-only (PNG/JPG/WebP) so the bytes are directly
 * ingestible as visual references by the image model (deep reference integration). Stored in the
 * tenant's REGIONAL DB at the top-level `brand_assets/{id}` collection; the served URL is DERIVED.
 *
 * NOT to be confused with `src/lib/tenant/brandAsset.ts` (the brand-guideline PDF store).
 */
export const BrandAssetCategorySchema = z.enum(["icon", "graphic"]);
export type BrandAssetCategory = z.infer<typeof BrandAssetCategorySchema>;

export const BrandAssetSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  category: BrandAssetCategorySchema,
  /** Bare stored filename (`<uuid>.<ext>`); the full GCS key is reconstructed server-side. */
  filename: z.string().max(300),
  mimeType: z.string().max(60),
  /** User-facing display name (defaults to the uploaded filename). */
  title: z.string().max(200),
  byteSize: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type BrandAsset = z.infer<typeof BrandAssetSchema>;
