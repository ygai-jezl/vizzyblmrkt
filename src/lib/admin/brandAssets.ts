import { randomUUID } from "node:crypto";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { Region } from "@/lib/types/tenant";
import { BrandAssetSchema, type BrandAsset, type BrandAssetCategory } from "@/lib/types/brandAsset";

/**
 * Registry helpers for the tenant's uploaded brand ASSETS — ICONS + GRAPHICS (Brand Kit →
 * Icons / Graphics). ONE collection discriminated by `category`. Mirrors src/lib/admin/brandLogos.ts.
 * Bytes live in GCS via src/lib/tenant/brandAssetStore.ts; this owns the `brand_assets` rows.
 * Category-filtered reads use the (tenantId, category, createdAt) composite index.
 */
export const MAX_ASSETS_PER_CATEGORY = 100;

/** All of the tenant's assets in a category, newest first. */
export async function listBrandAssets(
  ctx: TenantContext,
  category: BrandAssetCategory,
): Promise<BrandAsset[]> {
  return forTenant(ctx).brandAssets.find({
    where: [["category", "==", category]],
    orderBy: [["createdAt", "desc"]],
    limit: MAX_ASSETS_PER_CATEGORY,
  });
}

/** Fetch one asset (tenant-safe: getById re-checks the stored tenantId). */
export async function getBrandAsset(ctx: TenantContext, id: string): Promise<BrandAsset | null> {
  return forTenant(ctx).brandAssets.getById(id);
}

/**
 * Fast per-category count (bounded by `limit`). Two equality filters (tenantId + category) and NO
 * orderBy — served by automatic single-field indexes, so it works while the composite index is
 * still building. The upload route uses it to enforce the per-category cap.
 */
export async function countBrandAssetsUpTo(
  ctx: TenantContext,
  category: BrandAssetCategory,
  limit: number,
): Promise<number> {
  const rows = await forTenant(ctx).brandAssets.find({
    where: [["category", "==", category]],
    limit,
  });
  return rows.length;
}

export type RecordBrandAssetInput = Omit<BrandAsset, "id" | "tenantId" | "createdAt">;

/** Persist an uploaded asset into the registry. THROWS on failure (the bytes are already stored). */
export async function recordBrandAsset(
  scope: { tenantId: string; region: Region },
  input: RecordBrandAssetInput,
): Promise<BrandAsset> {
  const id = randomUUID();
  const doc = BrandAssetSchema.parse({
    ...input,
    id,
    tenantId: scope.tenantId,
    createdAt: new Date().toISOString(),
  });
  const ctx: TenantContext = { tenantId: scope.tenantId, region: scope.region, source: "system" };
  return forTenant(ctx).brandAssets.create(id, doc);
}

/** Patch an asset row (rename); returns the fresh row, or null if it isn't the tenant's. */
export async function updateBrandAsset(
  ctx: TenantContext,
  id: string,
  patch: Partial<Omit<BrandAsset, "id" | "tenantId" | "createdAt">>,
): Promise<BrandAsset | null> {
  const existing = await forTenant(ctx).brandAssets.getById(id);
  if (!existing) return null;
  await forTenant(ctx).brandAssets.update(id, patch);
  return { ...existing, ...patch };
}

export async function deleteBrandAsset(ctx: TenantContext, id: string): Promise<void> {
  await forTenant(ctx).brandAssets.delete(id);
}
