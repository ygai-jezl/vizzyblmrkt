import { randomUUID } from "node:crypto";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { Region } from "@/lib/types/tenant";
import { BrandFontSchema, type BrandFont } from "@/lib/types/brandFont";

/**
 * Registry helpers for the tenant's uploaded custom FONT FILES (Brand Kit → Fonts). Mirrors
 * src/lib/admin/brandLogos.ts (brand-global metadata, regional DB, whole-list fetch — fonts are
 * few). Bytes live in GCS via src/lib/tenant/brandFontStore.ts; this owns the `brand_fonts` rows.
 */
export const MAX_FONTS_PER_TENANT = 30;

/** All of the tenant's uploaded fonts, newest first. */
export async function listBrandFonts(ctx: TenantContext): Promise<BrandFont[]> {
  return forTenant(ctx).brandFonts.find({
    orderBy: [["createdAt", "desc"]],
    limit: MAX_FONTS_PER_TENANT,
  });
}

/** Fetch one font (tenant-safe: getById re-checks the stored tenantId). */
export async function getBrandFont(ctx: TenantContext, id: string): Promise<BrandFont | null> {
  return forTenant(ctx).brandFonts.getById(id);
}

/**
 * Fast, index-free font count (bounded by `limit`). Uses NO orderBy, so it relies only on the
 * automatic single-field tenantId index and works even while the (tenantId, createdAt) composite
 * index is still building — the upload route uses it to enforce the cap.
 */
export async function countBrandFontsUpTo(ctx: TenantContext, limit: number): Promise<number> {
  const rows = await forTenant(ctx).brandFonts.find({ limit });
  return rows.length;
}

export type RecordBrandFontInput = Omit<BrandFont, "id" | "tenantId" | "createdAt">;

/** Persist an uploaded font into the registry. THROWS on failure (the bytes are already stored). */
export async function recordBrandFont(
  scope: { tenantId: string; region: Region },
  input: RecordBrandFontInput,
): Promise<BrandFont> {
  const id = randomUUID();
  const doc = BrandFontSchema.parse({
    ...input,
    id,
    tenantId: scope.tenantId,
    createdAt: new Date().toISOString(),
  });
  const ctx: TenantContext = { tenantId: scope.tenantId, region: scope.region, source: "system" };
  return forTenant(ctx).brandFonts.create(id, doc);
}

/** Patch a font row (rename); returns the fresh row, or null if it isn't the tenant's. */
export async function updateBrandFont(
  ctx: TenantContext,
  id: string,
  patch: Partial<Omit<BrandFont, "id" | "tenantId" | "createdAt">>,
): Promise<BrandFont | null> {
  const existing = await forTenant(ctx).brandFonts.getById(id);
  if (!existing) return null;
  await forTenant(ctx).brandFonts.update(id, patch);
  return { ...existing, ...patch };
}

export async function deleteBrandFont(ctx: TenantContext, id: string): Promise<void> {
  await forTenant(ctx).brandFonts.delete(id);
}
