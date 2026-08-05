import { z } from "zod";

/**
 * A tenant's uploaded custom FONT FILE (Brand Kit → Fonts → "Upload a font"). Like brand
 * logos, fonts are BRAND-GLOBAL: the bytes live at a tenant-level GCS key
 * (`brand/{tenantId}/fonts/{uuid}.{ext}`) and are served by the PUBLIC /api/brand-font proxy
 * (unguessable-uuid credential) so an `@font-face` rule can load them for in-app preview.
 * Stored in the tenant's REGIONAL DB at the top-level `brand_fonts/{id}` collection; the served
 * URL is DERIVED, never stored. Distinct from the STYLE config (tenant.brandTypography): this is
 * the raw file + its family name, which the font picker offers alongside the curated families.
 */
export const BrandFontSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  /** CSS family name this file registers (used in @font-face + the picker). */
  family: z.string().max(80),
  /** Bare stored filename (`<uuid>.<ext>`); the full GCS key is reconstructed server-side. */
  filename: z.string().max(300),
  mimeType: z.string().max(60),
  /** User-facing display name (defaults to the uploaded filename). */
  title: z.string().max(200),
  byteSize: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type BrandFont = z.infer<typeof BrandFontSchema>;
