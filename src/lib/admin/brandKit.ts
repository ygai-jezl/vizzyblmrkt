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

/**
 * Patch an image asset (tenant-scoped update re-verifies ownership + strips
 * tenantId/id/createdAt). Returns the fresh row, or null if it doesn't exist for
 * this tenant. Used by the brand-style feedback loop (vote + styleProfile writes).
 */
export async function updateImageAsset(
  ctx: TenantContext,
  id: string,
  patch: Partial<Omit<ImageAsset, "id" | "tenantId" | "createdAt">>,
): Promise<ImageAsset | null> {
  const existing = await forTenant(ctx).imageAssets.getById(id);
  if (!existing) return null;
  await forTenant(ctx).imageAssets.update(id, patch);
  return { ...existing, ...patch };
}

/**
 * Record (or clear) the operator's brand-fit verdict on an image. A vote stamps
 * `brandVoteSetAt`; a 👎 or a clear (null) drops the numeric rating. Idempotent.
 */
export async function setImageBrandVote(
  ctx: TenantContext,
  id: string,
  input: { vote: "up" | "down" | null; rating?: number | null },
): Promise<ImageAsset | null> {
  const vote = input.vote;
  const rating = vote === "up" ? (input.rating ?? null) : null;
  return updateImageAsset(ctx, id, {
    brandVote: vote,
    brandRating: rating,
    brandVoteSetAt: vote ? new Date().toISOString() : null,
  });
}

/**
 * The tenant's positive brand exemplars (👍), highest-rated first then newest.
 * Backs the L1 style synthesis and the L2 reference-image pool. Needs the
 * (tenantId, brandVote, brandRating desc, createdAt desc) composite index.
 */
export async function listBrandExemplars(
  ctx: TenantContext,
  params: { minRating?: number; limit?: number } = {},
): Promise<ImageAsset[]> {
  const rows = await forTenant(ctx).imageAssets.find({
    where: [["brandVote", "==", "up"]],
    orderBy: [
      ["brandRating", "desc"],
      ["createdAt", "desc"],
    ],
    limit: Math.min(params.limit ?? 20, 100),
  });
  const min = params.minRating ?? 0;
  return min > 0 ? rows.filter((r) => (r.brandRating ?? 0) >= min) : rows;
}

/** The tenant's negative exemplars (👎) — off-brand traits to steer away from. */
export async function listBrandNegatives(
  ctx: TenantContext,
  params: { limit?: number } = {},
): Promise<ImageAsset[]> {
  return forTenant(ctx).imageAssets.find({
    where: [["brandVote", "==", "down"]],
    orderBy: [["createdAt", "desc"]],
    limit: Math.min(params.limit ?? 8, 50),
  });
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
