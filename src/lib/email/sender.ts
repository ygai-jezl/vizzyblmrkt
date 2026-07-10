import type { Tenant } from "@/lib/types/tenant";

/**
 * The effective sender identity for one outbound email. Any field left undefined
 * means "no override" — the email layer (src/lib/email/index.ts) falls back to
 * the env-configured EMAIL_FROM / EMAIL_REPLY_TO.
 */
export interface ResolvedSender {
  fromName?: string;
  fromEmail?: string;
  replyTo?: string;
}

/** The optional per-campaign override fields (see Campaign.email*). */
export interface CampaignSenderOverrides {
  emailFromName?: string;
  emailFromAddress?: string;
  emailReplyTo?: string;
}

function domainOf(email: string | undefined): string | undefined {
  if (!email) return undefined;
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).toLowerCase() : undefined;
}

/**
 * Resolve the sender identity for an outbound email. Precedence per field:
 * per-campaign override → tenant-level default (Account Settings → Domains) →
 * undefined (env fallback at the email layer).
 *
 * A custom From ADDRESS is only used when its domain is VERIFIED at the tenant
 * level; otherwise the mail would fail SPF/DKIM, so we drop it and let the
 * provider default apply. The display name and reply-to carry no DNS dependency,
 * so they are always honoured.
 */
export function resolveSender(
  tenant: Tenant | null | undefined,
  campaign?: CampaignSenderOverrides | null,
): ResolvedSender {
  const cfg = tenant?.emailSenderConfig;
  const verified = new Set(
    (cfg?.domains ?? [])
      .filter((d) => d.status === "verified")
      .map((d) => d.domain.toLowerCase()),
  );

  const tenantFrom =
    cfg?.fromLocalPart && cfg?.fromDomain
      ? `${cfg.fromLocalPart}@${cfg.fromDomain}`
      : undefined;

  const fromCandidate = campaign?.emailFromAddress?.trim() || tenantFrom;
  const fromEmail =
    fromCandidate && verified.has(domainOf(fromCandidate) ?? "")
      ? fromCandidate
      : undefined;

  const fromName = campaign?.emailFromName?.trim() || cfg?.senderName?.trim() || undefined;
  const replyTo = campaign?.emailReplyTo?.trim() || cfg?.replyTo?.trim() || undefined;

  return { fromName, fromEmail, replyTo };
}

/** App-default brand, used only when a tenant has configured no sender identity. */
const APP_BRAND_FALLBACK = "YouGrow.ai";

/** Display name parsed out of the env EMAIL_FROM ("Name <addr>"), if any. */
function envFromName(): string | undefined {
  const from = process.env.EMAIL_FROM;
  const m = from?.match(/^\s*(.*?)\s*<[^>]+>\s*$/);
  return m?.[1]?.trim() || undefined;
}

/**
 * The brand shown in the footer's "This email was sent by {Brand}." — the
 * display name tied to the tenant's verified sending domain (emailSenderConfig
 * .senderName, via resolveSender.fromName, with a per-campaign override). Falls
 * back to the tenant name, then the env sender name, then the app default, so
 * the footer is never blank.
 */
export function resolveFooterBrand(
  tenant: Tenant | null | undefined,
  campaign?: CampaignSenderOverrides | null,
): string {
  return (
    resolveSender(tenant, campaign).fromName ||
    tenant?.tenantName?.trim() ||
    envFromName() ||
    APP_BRAND_FALLBACK
  );
}
