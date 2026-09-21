import { createHash } from "node:crypto";
import { forTenant } from "@/lib/tenant";
import { TenantIsolationError } from "@/lib/tenant/errors";
import type { TenantContext, FirestoreLike } from "@/lib/tenant/types";
import type { EmailSuppressionReason } from "@/lib/types/emailSuppression";
import { normalizeEmail } from "@/lib/waitlist/identifiers";

/**
 * Tenant-wide email suppression: the send-time opt-out enforcement behind the
 * footer's Unsubscribe. `suppressEmail` records an opt-out (idempotent);
 * `isSuppressed` is checked before every Mandrill marketing send (journey
 * worker). Broadcasts are additionally enforced by removing the address from the
 * MailChimp audience. See lib/types/emailSuppression.ts.
 */

/** Deterministic per-(tenant, email) doc id — dedupes replays AND prevents two
 *  tenants sharing a region from colliding on the same address. */
export function suppressionDocId(tenantId: string, email: string): string {
  const hash = createHash("sha256")
    .update(`${tenantId}\n${normalizeEmail(email)}`)
    .digest("hex")
    .slice(0, 40);
  return `sup_${hash}`;
}

/** Deterministic per-(tenant, email, category) id for a CATEGORY opt-out. */
export function categorySuppressionDocId(tenantId: string, email: string, category: string): string {
  const hash = createHash("sha256")
    .update(`${tenantId}\n${normalizeEmail(email)}\n${category}`)
    .digest("hex")
    .slice(0, 40);
  return `supc_${hash}`;
}

export interface SuppressInput {
  email: string;
  reason: EmailSuppressionReason;
  /** Where the opt-out came from (e.g. "footer", "list-unsubscribe", a webhook). */
  source: string;
  campaignId?: string | null;
  signupId?: string | null;
}

/** Idempotently record a tenant-wide opt-out. Safe to call repeatedly. */
export async function suppressEmail(
  ctx: TenantContext,
  input: SuppressInput,
  db?: FirestoreLike,
): Promise<void> {
  const normalizedEmail = normalizeEmail(input.email);
  if (!normalizedEmail) return;
  const id = suppressionDocId(ctx.tenantId, normalizedEmail);
  try {
    await forTenant(ctx, db).emailSuppressions.create(id, {
      normalizedEmail,
      email: input.email.trim(),
      reason: input.reason,
      source: input.source,
      campaignId: input.campaignId ?? null,
      signupId: input.signupId ?? null,
      scope: "all",
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    // Already suppressed (same tenant + email) — the deterministic id collided.
    if (err instanceof TenantIsolationError) return;
    throw err;
  }
}

/** Whether an address is currently suppressed for this tenant. */
export async function isSuppressed(
  ctx: TenantContext,
  email: string | null | undefined,
  db?: FirestoreLike,
): Promise<boolean> {
  if (!email) return false;
  const id = suppressionDocId(ctx.tenantId, email);
  const doc = await forTenant(ctx, db).emailSuppressions.getById(id);
  return doc != null;
}

/**
 * Idempotently record a CATEGORY opt-out (lifecycle email in one category, e.g.
 * "onboarding"). Other marketing to the address is unaffected.
 */
export async function suppressEmailCategory(
  ctx: TenantContext,
  input: { email: string; category: string; source: string; connectionId?: string | null; recipientId?: string | null },
  db?: FirestoreLike,
): Promise<void> {
  const normalizedEmail = normalizeEmail(input.email);
  if (!normalizedEmail) return;
  try {
    await forTenant(ctx, db).emailSuppressions.create(
      categorySuppressionDocId(ctx.tenantId, normalizedEmail, input.category),
      {
        normalizedEmail,
        email: input.email.trim(),
        reason: "unsubscribe",
        source: input.source,
        scope: "category",
        category: input.category,
        connectionId: input.connectionId ?? null,
        recipientId: input.recipientId ?? null,
        createdAt: new Date().toISOString(),
      },
    );
  } catch (err) {
    if (err instanceof TenantIsolationError) return; // already opted out of this category
    throw err;
  }
}

/** Whether the address opted out of this category (or of everything). */
export async function isSuppressedFor(
  ctx: TenantContext,
  email: string | null | undefined,
  category: string,
  db?: FirestoreLike,
): Promise<boolean> {
  if (!email) return false;
  const repo = forTenant(ctx, db).emailSuppressions;
  const [all, cat] = await Promise.all([
    repo.getById(suppressionDocId(ctx.tenantId, email)),
    repo.getById(categorySuppressionDocId(ctx.tenantId, email, category)),
  ]);
  return all != null || cat != null;
}
