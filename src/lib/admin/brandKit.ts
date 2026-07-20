import { randomUUID } from "node:crypto";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { WhereClause } from "@/lib/tenant/repository";
import type { Region } from "@/lib/types/tenant";
import { ImageAssetSchema, type ImageAsset } from "@/lib/types/imageAsset";

export const BRAND_KIT_PAGE_SIZE = 60;

export interface ListImagesParams {
  /** Keyset cursor: the createdAt of the last row of the previous page. */
  cursor?: string;
  /** Optional primary filter by ImageAsset.kind (needs the (tenantId, kind, createdAt) index). */
  kind?: string;
  limit?: number;
}

export interface ListResult<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * List the tenant's image assets for the Brand Kit gallery, newest first, keyset-
 * paginated over createdAt. Backed by the (tenantId, createdAt) composite index (and
 * (tenantId, kind, createdAt) when `kind` is set). The RSC caller wraps this in a
 * try/catch and degrades to an empty gallery while an index is still building.
 *
 * NOTE: the cursor is the single createdAt value (no unique tiebreaker), matching the
 * CRM list pattern in src/lib/admin/crm.ts. If several images share the EXACT same
 * millisecond createdAt AND that group straddles a page boundary, startAfter([createdAt])
 * excludes the whole tie group, so the overflow ties won't appear on the next page (a
 * rare, no-data-loss edge — the docs/bytes still exist). If this ever matters, add a
 * unique tiebreak (store the doc id as a field, order by [createdAt desc, id desc], and
 * carry both in the cursor) plus the matching composite index.
 */
export async function listImageAssets(
  ctx: TenantContext,
  params: ListImagesParams = {},
): Promise<ListResult<ImageAsset>> {
  const limit = Math.min(params.limit ?? BRAND_KIT_PAGE_SIZE, 200);
  const where: WhereClause[] = [];
  if (params.kind) where.push(["kind", "==", params.kind]);

  const rows = await forTenant(ctx).imageAssets.find({
    where,
    orderBy: [["createdAt", "desc"]],
    startAfter: params.cursor ? [params.cursor] : undefined,
    limit: limit + 1,
  });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? (items[items.length - 1]!.createdAt ?? null) : null;
  return { items, nextCursor };
}

/** Fetch one image asset (tenant-safe: getById re-checks the stored tenantId). */
export async function getImageAsset(
  ctx: TenantContext,
  id: string,
): Promise<ImageAsset | null> {
  return forTenant(ctx).imageAssets.getById(id);
}

export async function deleteImageAsset(ctx: TenantContext, id: string): Promise<void> {
  await forTenant(ctx).imageAssets.delete(id);
}

export type RecordImageInput = Omit<ImageAsset, "id" | "tenantId" | "createdAt">;

/**
 * Persist a generated image into the registry. Called from the creative service with a
 * minimal { tenantId, region } scope (enough for forTenant). THROWS on failure — the
 * Customise flow wants the record to succeed. Generation-path callers wrap this in
 * `.catch(...)` so a Firestore blip never fails an already-stored image.
 */
export async function recordImageAsset(
  scope: { tenantId: string; region: Region },
  input: RecordImageInput,
): Promise<ImageAsset> {
  const id = randomUUID();
  const doc = ImageAssetSchema.parse({
    ...input,
    id,
    tenantId: scope.tenantId,
    createdAt: new Date().toISOString(),
  });
  const ctx: TenantContext = {
    tenantId: scope.tenantId,
    region: scope.region,
    source: "system",
  };
  return forTenant(ctx).imageAssets.create(id, doc);
}
