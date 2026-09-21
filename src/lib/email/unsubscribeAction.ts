import { forTenant, getTenantById } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import { suppressEmail, suppressEmailCategory } from "@/lib/email/suppression";
import { resolveMailchimpConfig, archiveMember } from "@/lib/mailchimp";
import type { UnsubscribeClaims, UnsubscribeClaimsV2 } from "@/lib/email/unsubscribeToken";
import { enqueueConnectionWebhook } from "@/lib/lifecycle/webhooksOut";

/**
 * Apply a TENANT-WIDE unsubscribe from verified token claims — the single write
 * path shared by the /api/unsubscribe route (one-click header + page button):
 *   1. record the opt-out in `email_suppressions` (blocks Mandrill/journey sends),
 *   2. stamp `unsubscribedAt` on the signup (CRM/analytics view — best-effort),
 *   3. archive the address from the MailChimp audience (stops broadcasts too).
 * Idempotent and best-effort on the side-effects (a re-click / replay is a no-op).
 */
export async function applyUnsubscribe(
  claims: UnsubscribeClaims,
  source: string,
): Promise<{ ok: boolean; tenant: Tenant | null }> {
  const tenant = await getTenantById(claims.tenantId).catch(() => null);
  if (!tenant) return { ok: false, tenant: null };

  const ctx: TenantContext = {
    tenantId: tenant.id,
    region: tenant.region,
    source: "system",
  };

  await suppressEmail(ctx, {
    email: claims.email,
    reason: "unsubscribe",
    source,
    campaignId: claims.campaignId || null,
    signupId: claims.signupId || null,
  });

  if (claims.signupId) {
    await forTenant(ctx)
      .signups.update(claims.signupId, { unsubscribedAt: new Date().toISOString() })
      .catch(() => {});
  }

  const cfg = resolveMailchimpConfig(tenant);
  if (cfg.ok) {
    await archiveMember(cfg.config, claims.email).catch(() => {});
  }

  return { ok: true, tenant };
}

/**
 * Apply a LIFECYCLE (v2 token) unsubscribe for a connected product's user.
 *  - `category` (the one-click default): stop only this category (e.g.
 *    onboarding tips) — no tenant-wide suppression, no MailChimp archive.
 *  - `all` (only from the hosted page): the tenant-wide opt-out, as a v1 token.
 * Either way the product is told (a signed `email_preferences.updated` webhook,
 * carrying the product's own user id, never the email) so it can mirror it.
 * Idempotent: a repeat click records nothing new and queues no second webhook.
 */
export async function applyLifecycleUnsubscribe(
  claims: UnsubscribeClaimsV2,
  scope: "category" | "all",
  source: string,
  db?: FirestoreLike,
): Promise<{ ok: boolean; tenant: Tenant | null }> {
  const tenant = await getTenantById(claims.tenantId, db).catch(() => null);
  if (!tenant) return { ok: false, tenant: null };
  const ctx: TenantContext = { tenantId: tenant.id, region: tenant.region, source: "system" };

  if (scope === "all") {
    await suppressEmail(ctx, { email: claims.email, reason: "unsubscribe", source }, db);
    const cfg = resolveMailchimpConfig(tenant);
    if (cfg.ok) await archiveMember(cfg.config, claims.email).catch(() => {});
  } else {
    await suppressEmailCategory(
      ctx,
      {
        email: claims.email,
        category: claims.category,
        source,
        connectionId: claims.connectionId,
        recipientId: claims.recipientId,
      },
      db,
    );
  }

  const user = await forTenant(ctx, db).productUsers.getById(claims.recipientId).catch(() => null);
  if (user && user.connectionId === claims.connectionId) {
    await enqueueConnectionWebhook(
      ctx,
      {
        connectionId: claims.connectionId,
        type: "email_preferences.updated",
        data: { userId: user.externalUserId, category: claims.category, subscribed: false, scope, source },
        dedupeKey: `unsub:${claims.recipientId}:${claims.category}:${scope}`,
      },
      db,
    ).catch((err) => {
      console.warn(`[unsubscribe] webhook enqueue failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
    });
  }
  return { ok: true, tenant };
}
