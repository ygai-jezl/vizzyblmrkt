import { forTenant, getTenantById } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import { suppressEmail } from "@/lib/email/suppression";
import { resolveMailchimpConfig, archiveMember } from "@/lib/mailchimp";
import type { UnsubscribeClaims } from "@/lib/email/unsubscribeToken";

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
