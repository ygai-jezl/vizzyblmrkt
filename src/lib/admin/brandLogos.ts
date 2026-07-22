import { randomUUID } from "node:crypto";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { Region } from "@/lib/types/tenant";
import { BrandLogoSchema, type BrandLogo } from "@/lib/types/brandLogo";

/**
 * Hard cap on logos per tenant. Brand logos are few (primary, mark, light/dark variants),
 * so the list is fetched whole (no pagination) — one query, newest-first, in-memory
 * primary pick. Backed by the (tenantId, createdAt) composite index.
 */
export const MAX_LOGOS_PER_TENANT = 60;

/** All of the tenant's logos, newest first. */
export async function listLogos(ctx: TenantContext): Promise<BrandLogo[]> {
  return forTenant(ctx).logos.find({
    orderBy: [["createdAt", "desc"]],
    limit: MAX_LOGOS_PER_TENANT,
  });
}

/** Fetch one logo (tenant-safe: getById re-checks the stored tenantId). */
export async function getLogo(ctx: TenantContext, id: string): Promise<BrandLogo | null> {
  return forTenant(ctx).logos.getById(id);
}

/**
 * The tenant's primary logo, or null when it has none. Derivation: the explicitly-flagged
 * primary, else the NEWEST logo. The newest-fallback keeps "primary" deterministic without
 * a promotion write — so deleting the flagged primary, a partial set-primary, or the
 * index-building window all still resolve to a real logo (never a null when logos exist).
 */
export async function getPrimaryLogo(ctx: TenantContext): Promise<BrandLogo | null> {
  const logos = await listLogos(ctx);
  return logos.find((l) => l.isPrimary) ?? logos[0] ?? null;
}

/**
 * Fast, index-free logo count (bounded by `limit`, i.e. it returns min(actual, limit)). Uses
 * NO orderBy, so it relies only on the automatic single-field tenantId index and works even
 * while the (tenantId, createdAt) composite index is still building — the upload route uses
 * it to enforce the cap + decide the first-logo primary without depending on listLogos.
 */
export async function countLogosUpTo(ctx: TenantContext, limit: number): Promise<number> {
  const rows = await forTenant(ctx).logos.find({ limit });
  return rows.length;
}

export type RecordLogoInput = Omit<BrandLogo, "id" | "tenantId" | "createdAt">;

/**
 * Persist an uploaded logo into the registry. Called from the upload route with a minimal
 * { tenantId, region } scope (enough for forTenant). THROWS on failure — the route wraps
 * this so a Firestore blip surfaces cleanly (the bytes are already stored above it).
 */
export async function recordLogo(
  scope: { tenantId: string; region: Region },
  input: RecordLogoInput,
): Promise<BrandLogo> {
  const id = randomUUID();
  const doc = BrandLogoSchema.parse({
    ...input,
    id,
    tenantId: scope.tenantId,
    createdAt: new Date().toISOString(),
  });
  const ctx: TenantContext = { tenantId: scope.tenantId, region: scope.region, source: "system" };
  return forTenant(ctx).logos.create(id, doc);
}

/**
 * Patch a logo (tenant-scoped update re-verifies ownership + strips tenantId/id/createdAt).
 * Returns the fresh row, or null if it doesn't exist for this tenant.
 */
export async function updateLogo(
  ctx: TenantContext,
  id: string,
  patch: Partial<Omit<BrandLogo, "id" | "tenantId" | "createdAt">>,
): Promise<BrandLogo | null> {
  const existing = await forTenant(ctx).logos.getById(id);
  if (!existing) return null;
  await forTenant(ctx).logos.update(id, patch);
  return { ...existing, ...patch };
}

export async function deleteLogo(ctx: TenantContext, id: string): Promise<void> {
  await forTenant(ctx).logos.delete(id);
}

/**
 * Make `id` the tenant's ONE primary logo: set it, clear any other primaries. Two writes
 * (not a transaction) — logos are few and effectively single-editor; a rare interleave
 * self-heals on the next set. Returns the promoted row, or null if `id` isn't the tenant's.
 */
export async function setPrimaryLogo(ctx: TenantContext, id: string): Promise<BrandLogo | null> {
  const logos = await listLogos(ctx);
  const target = logos.find((l) => l.id === id);
  if (!target) return null;
  await Promise.all(
    logos
      .filter((l) => l.isPrimary && l.id !== id)
      .map((l) => forTenant(ctx).logos.update(l.id, { isPrimary: false })),
  );
  if (!target.isPrimary) await forTenant(ctx).logos.update(id, { isPrimary: true });
  return { ...target, isPrimary: true };
}
