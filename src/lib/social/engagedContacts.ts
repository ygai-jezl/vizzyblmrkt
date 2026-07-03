import { forTenant, TenantIsolationError } from "@/lib/tenant";
import type { TenantContext, FirestoreLike } from "@/lib/tenant/types";
import { deterministicContactId } from "@/lib/crm/identifiers";
import { buildSearchTokens } from "@/lib/crm/searchTokens";

/**
 * Upsert the "Engaged" record for someone who ENGAGED on social. Lives in the
 * dedicated `social_engaged` collection (NOT `contacts`), so scraped social
 * identities never touch the email CRM. Keyed by `engaged:{platform}:{userId}`.
 *
 * Idempotent, mirroring upsertContactFromSignup: deterministic id + atomic create,
 * and on collision a best-effort merge that fills newly-known fields (never clobbers
 * an enriched field with null), bumps lastEngagedAt, and increments engagementCount.
 */
export interface EngagedContactInput {
  platform: "x" | "instagram" | "linkedin";
  userId: string;
  handle?: string | null;
  name?: string | null;
  bio?: string | null;
  location?: string | null;
  followers?: number | null;
  following?: number | null;
  /** When this engagement happened (ISO). */
  engagedAt: string;
}

/** Keep a newly-provided value only when non-nullish (don't overwrite with null). */
function coalesce<T>(next: T | null | undefined, prev: T | null | undefined): T | null {
  return next ?? prev ?? null;
}

export async function upsertEngagedContact(
  ctx: TenantContext,
  input: EngagedContactInput,
  db?: FirestoreLike,
): Promise<"created" | "updated"> {
  const id = deterministicContactId(ctx.tenantId, `engaged:${input.platform}:${input.userId}`);
  const repo = forTenant(ctx, db).socialEngaged;
  const now = new Date().toISOString();
  const searchTokens = buildSearchTokens([input.handle, input.name]);

  try {
    await repo.create(id, {
      platform: input.platform,
      userId: input.userId,
      handle: input.handle ?? null,
      name: input.name ?? null,
      bio: input.bio ?? null,
      location: input.location ?? null,
      followers: input.followers ?? null,
      following: input.following ?? null,
      engagementCount: 1,
      searchTokens,
      firstEngagedAt: input.engagedAt,
      lastEngagedAt: input.engagedAt,
      createdAt: now,
      updatedAt: now,
    } as never);
    return "created";
  } catch (err) {
    if (!(err instanceof TenantIsolationError)) throw err;
  }

  // Collision → merge onto the existing engaged record.
  const existing = await repo.getById(id);
  if (!existing) throw new TenantIsolationError(`social_engaged/${id} vanished mid-upsert`);
  if (existing.tenantId !== ctx.tenantId) {
    throw new TenantIsolationError(`social_engaged/${id} belongs to another tenant`);
  }
  const mergedTokens = Array.from(new Set([...(existing.searchTokens ?? []), ...searchTokens]));
  await repo.update(id, {
    handle: coalesce(input.handle, existing.handle),
    name: coalesce(input.name, existing.name),
    bio: coalesce(input.bio, existing.bio),
    location: coalesce(input.location, existing.location),
    followers: coalesce(input.followers, existing.followers),
    following: coalesce(input.following, existing.following),
    engagementCount: (existing.engagementCount ?? 0) + 1,
    searchTokens: mergedTokens,
    lastEngagedAt: input.engagedAt,
    updatedAt: now,
  } as never);
  return "updated";
}
