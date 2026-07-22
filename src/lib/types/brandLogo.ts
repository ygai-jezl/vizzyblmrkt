import { z } from "zod";

/**
 * A tenant's uploaded corporate LOGO (Brand Kit → Logos). Unlike the AI-generated
 * `image_assets` registry (which is workspace-partitioned + served through the
 * authenticated workspace-asset proxy), logos are BRAND-GLOBAL assets: the bytes live
 * at a tenant-level GCS key (`brand/{tenantId}/logos/{uuid}.{ext}`) and are served by
 * the PUBLIC /api/brand-logo proxy (unguessable-uuid credential), so the primary logo
 * can render in recipient-facing emails. Stored in the tenant's REGIONAL DB at the
 * top-level `brand_logos/{id}` collection; the served URL is DERIVED, never stored.
 */
export const BrandLogoSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  /** Bare stored filename (`<uuid>.<ext>`); the full GCS key is reconstructed server-side. */
  filename: z.string().max(300),
  mimeType: z.string().max(60),
  /** User-facing display name (defaults to the uploaded filename). */
  title: z.string().max(200),
  byteSize: z.number().int().nonnegative(),
  /** Exactly one logo per tenant is the primary — the one wired into email headers. */
  isPrimary: z.boolean(),
  createdAt: z.string(),
});
export type BrandLogo = z.infer<typeof BrandLogoSchema>;
