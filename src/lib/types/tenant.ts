import { z } from "zod";

/**
 * Core tenant (brand / workspace). Lives in the root-level `tenants` collection.
 * This is the GLOBAL registry — it is the one set of documents that is NOT
 * tenant-scoped, because resolving "which tenant is this request for?" must
 * happen before a tenant context exists. See src/lib/tenant/registry.ts.
 */
export const TenantStatus = z.enum(["active", "suspended", "trial"]);
export type TenantStatus = z.infer<typeof TenantStatus>;

/**
 * Data-residency region. Logical code (decoupled from the physical Firestore
 * location) so the location stays swappable. Each region maps to its own
 * Firestore named database — see src/lib/tenant/region.ts.
 *
 * IMMUTABLE: a tenant's region is set at creation and never changes, because a
 * Firestore database's location cannot be moved. Per-tenant residency — all of
 * a brand's data lives in its one region.
 */
export const Region = z.enum(["us", "eu", "asia"]);
export type Region = z.infer<typeof Region>;

/**
 * Per-tenant MailChimp / email-provider config. Optional so tenant documents
 * predating this field still parse. By default a tenant uses the SHARED
 * MailChimp account (env-configured). When `requiresOwnApiKey` is true the
 * tenant is gated OFF the shared account and MUST bring its own credentials
 * (`apiKey` + `audienceId`). See src/lib/mailchimp/config.ts.
 */
export const MailchimpTenantConfigSchema = z.object({
  requiresOwnApiKey: z.boolean().default(false),
  apiKey: z.string().optional(),
  serverPrefix: z.string().optional(),
  audienceId: z.string().optional(),
});
export type MailchimpTenantConfig = z.infer<typeof MailchimpTenantConfigSchema>;

/**
 * Per-tenant Unified CRM gates. Optional so existing tenant docs parse; all
 * gates default OFF. These enforce the residency/privacy/abuse controls:
 * enrichment + engagement polling ship data to US/global vendors, so they are
 * OPT-IN and — for EU tenants — additionally require BYO vendor keys + a manual
 * DPA acknowledgement before any cross-region transfer. See the CRM plan §H.
 */
export const CrmTenantConfigSchema = z.object({
  /** Allow Agent-1 company enrichment (Gemini/Vertex). Default false. */
  enrichmentEnabled: z.boolean().default(false),
  /** Allow engagement polling (Mandrill/MailChimp). Default false. */
  engagementSyncEnabled: z.boolean().default(false),
  /** EU only: signed off that a DPA/SCC basis exists for vendor transfers. */
  gdprDpaVerified: z.boolean().default(false),
  /** Optional override of the per-tenant daily unique-company enrich cap. */
  dailyEnrichCap: z.number().int().positive().optional(),
});
export type CrmTenantConfig = z.infer<typeof CrmTenantConfigSchema>;

/**
 * One DNS record a tenant must publish to authenticate a custom sending domain
 * (SPF / DKIM / DMARC). `valid` reflects what the email provider (Mandrill) last
 * observed — see src/lib/email/senderDomains.ts.
 */
export const SenderDnsRecordSchema = z.object({
  type: z.enum(["TXT", "CNAME", "MX"]),
  host: z.string(),
  value: z.string(),
  valid: z.boolean().default(false),
});
export type SenderDnsRecord = z.infer<typeof SenderDnsRecordSchema>;

/**
 * How a tenant proved control of a domain, gating the WEB-ROUTING capability
 * (its origin in allowedOrigins + on the reCAPTCHA key). `email_match`: the
 * creating admin's verified-email registrable domain equals the claimed domain.
 * `dns_txt`: the admin published our challenge TXT. `mandrill_dns`: the domain
 * is already email-verified via Mandrill (publishing those records proves DNS
 * control). See src/lib/domains/ownership.ts.
 */
export const DomainOwnershipSchema = z.object({
  method: z.enum(["email_match", "dns_txt", "mandrill_dns"]),
  verifiedAt: z.string(),
  /** Firebase UID of the admin who proved ownership. */
  verifiedBy: z.string(),
  /** Matched email domain or the challenge TXT host, for the audit trail. */
  evidence: z.string().optional(),
});
export type DomainOwnership = z.infer<typeof DomainOwnershipSchema>;

/**
 * What a domain is enabled for. `email`: send From it (Mandrill DKIM/SPF).
 * `webRouting`: serve the widget from it (origin in allowedOrigins + on the
 * reCAPTCHA key). Defaulted so domain docs predating this field parse as
 * no-capabilities (email status is still driven by the existing fields).
 */
export const DomainCapabilitiesSchema = z.object({
  email: z.boolean().default(false),
  webRouting: z.boolean().default(false),
});
export type DomainCapabilities = z.infer<typeof DomainCapabilitiesSchema>;

/**
 * A custom domain the tenant is verifying / has verified. Originally email-only
 * (Mandrill DKIM+SPF + ownership — `status`/`dkimValid`/`spfValid`/`records`/
 * `verifyTxtKey`); now also a first-class verified domain that can carry the
 * web-routing capability once OWNERSHIP is proven. `records` is what the admin
 * publishes at their DNS host. Until "verified" it must not be a From address.
 */
export const SenderDomainSchema = z.object({
  domain: z.string(),
  status: z.enum(["pending", "verified", "failed"]).default("pending"),
  dkimValid: z.boolean().default(false),
  spfValid: z.boolean().default(false),
  records: z.array(SenderDnsRecordSchema).default([]),
  addedAt: z.string(),
  lastCheckedAt: z.string().optional(),
  /** Mandrill's per-domain ownership token; published as `mandrill_verify.<key>`. */
  verifyTxtKey: z.string().optional(),
  /** Last provider status/error detail surfaced to the admin. */
  detail: z.string().optional(),
  /** Proof of DNS control — gates the web-routing capability. */
  ownership: DomainOwnershipSchema.optional(),
  /**
   * What this domain is enabled for (email sending / web routing). Optional so
   * existing domain docs (and email-only callers) parse untouched; absent ⇒ no
   * web-routing capability.
   */
  capabilities: DomainCapabilitiesSchema.optional(),
  /** Pending DNS-TXT ownership challenge token (cleared once proven). */
  dnsTxtToken: z.string().optional(),
  /** When web routing was last revoked (origins pulled from allowedOrigins). */
  revokedAt: z.string().optional(),
});
export type SenderDomain = z.infer<typeof SenderDomainSchema>;

/**
 * Tenant-level (global) email sender identity + verified sending domains. Reused
 * across every launch; a launch may override the name/address/reply-to per
 * campaign (see Campaign.email* fields). Optional so tenant documents predating
 * this field still parse.
 */
export const EmailSenderConfigSchema = z.object({
  /** Display name on outbound mail, e.g. "Acme Team". */
  senderName: z.string().optional(),
  /** Local-part of the From address, e.g. "hello". */
  fromLocalPart: z.string().optional(),
  /** Verified domain the From address sends from, e.g. "mail.acme.com". */
  fromDomain: z.string().optional(),
  /** Reply-To address shown to recipients. */
  replyTo: z.string().optional(),
  domains: z.array(SenderDomainSchema).default([]),
});
export type EmailSenderConfig = z.infer<typeof EmailSenderConfigSchema>;

/**
 * A per-tenant OAuth connection to a git host (GitHub/GitLab), used to clone
 * PRIVATE repos during knowledge ingestion. The access token is stored ENCRYPTED
 * (AES-256-GCM; see src/lib/integrations/crypto.ts) — never plaintext. The worker
 * decrypts it at clone time.
 */
export const GitConnectionSchema = z.object({
  provider: z.enum(["github", "gitlab"]),
  /** Encrypted access token (ciphertext / iv / GCM tag), all base64. */
  enc: z.object({ ct: z.string(), iv: z.string(), tag: z.string() }),
  /** The connected account handle (for display). */
  accountLogin: z.string().optional(),
  scope: z.string().optional(),
  /** Firebase UID of the admin who connected. */
  connectedBy: z.string().optional(),
  connectedAt: z.string(),
});
export type GitConnection = z.infer<typeof GitConnectionSchema>;

/**
 * A per-tenant OAuth 2.0 connection to a social platform (X now; Instagram/LinkedIn
 * later), used to publish on the account owner's behalf. Access + refresh tokens are
 * stored ENCRYPTED (AES-256-GCM; src/lib/social/crypto.ts) — never plaintext.
 */
export const SocialConnectionSchema = z.object({
  platform: z.enum(["x", "instagram", "linkedin"]),
  /** Encrypted access token (ciphertext / iv / GCM tag, all base64). */
  enc: z.object({ ct: z.string(), iv: z.string(), tag: z.string() }),
  /** Encrypted refresh token (offline.access), when the platform issues one. */
  refreshEnc: z
    .object({ ct: z.string(), iv: z.string(), tag: z.string() })
    .nullable()
    .optional(),
  /** Connected account handle/username (for display). */
  handle: z.string().optional(),
  /** The account's stable platform user id (X numeric id). Attribution key for
   *  inbound engagement webhooks — see social_subscriptions in tenant/control.ts. */
  userId: z.string().optional(),
  scope: z.string().optional(),
  /** ISO expiry of the access token (refresh before this). */
  expiresAt: z.string().nullable().optional(),
  /** Firebase UID of the admin who connected. */
  connectedBy: z.string().optional(),
  connectedAt: z.string(),
});
export type SocialConnection = z.infer<typeof SocialConnectionSchema>;

export const TenantSchema = z.object({
  id: z.string(),
  tenantName: z.string(),
  rootDomain: z.string(),
  /**
   * Brand favicon URL, shown at the top of the admin shell. Pulled in
   * automatically at tenant creation (derived from `rootDomain` — see
   * src/lib/tenant/favicon.ts and createTenant). Defaults to "" so tenant
   * documents predating this field still parse; the admin shell then derives a
   * fallback at render time (or shows a monogram).
   */
  faviconUrl: z.string().default(""),
  status: TenantStatus,
  /** Data-residency region. IMMUTABLE once set (see Region). */
  region: Region,
  /** Allow-listed full origins (scheme + host) for CORS / embed / signup gating. */
  allowedOrigins: z.array(z.string()),
  billingTier: z.string(),
  /** Firebase Auth UID of the primary creator. */
  ownerId: z.string(),
  /** Per-tenant MailChimp / email-provider config + BYO feature gate. */
  mailchimpConfig: MailchimpTenantConfigSchema.optional(),
  /** Global custom-domain email sender identity + verified domains. */
  emailSenderConfig: EmailSenderConfigSchema.optional(),
  /** Unified CRM feature gates (enrichment / engagement / EU DPA). */
  crmConfig: CrmTenantConfigSchema.optional(),
  /** Per-provider OAuth git connections (encrypted tokens) for private-repo ingest.
   *  String-keyed (not an enum record) so a tenant with only ONE provider connected
   *  still parses — an enum-keyed z.record is exhaustive and would require both. */
  gitConnections: z.record(z.string(), GitConnectionSchema).optional(),
  /** Per-platform OAuth social connections (encrypted tokens) for Distribute publishing.
   *  String-keyed (not an enum record) so a tenant with only ONE platform still parses. */
  socialConnections: z.record(z.string(), SocialConnectionSchema).optional(),
  /**
   * Tenant-level multilingual defaults — the brand's fallback content language
   * (`defaultLocale`) and allow-list (`supportedLocales`) used when a launch does
   * not pin its own. Optional so existing tenant docs parse. CONTENT LANGUAGE
   * ONLY: strictly DISTINCT from `region` (data residency) — a locale must never
   * derive, mutate, or substitute `region`.
   */
  defaultLocale: z.string().optional(),
  supportedLocales: z.array(z.string()).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Tenant = z.infer<typeof TenantSchema>;
