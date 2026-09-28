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
  /**
   * Physical postal address printed in the footer of lifecycle (connected-product)
   * emails — required for marketing mail in several jurisdictions (CAN-SPAM).
   */
  postalAddress: z.string().max(300).optional(),
  /**
   * Public Privacy Policy URL, rendered as the "Privacy Policy" link in every
   * marketing email footer. Required going forward (enforced in the Domains
   * settings form + PUT route); optional here so tenant docs predating the
   * field still parse — the footer falls back to DEFAULT_PRIVACY_URL.
   */
  privacyPolicyUrl: z.string().url().optional(),
  domains: z.array(SenderDomainSchema).default([]),
});
export type EmailSenderConfig = z.infer<typeof EmailSenderConfigSchema>;

/** One repo an admin selected on a git connection (lowercased `fullPath` is the key). */
export const GitSelectedRepoSchema = z.object({
  fullPath: z.string().min(3).max(512),
  owner: z.string().max(255),
  private: z.boolean(),
  defaultBranch: z.string().max(255).nullable(),
  webUrl: z.string().url(),
});
export type GitSelectedRepo = z.infer<typeof GitSelectedRepoSchema>;

/**
 * A per-tenant OAuth connection to a git host (GitHub/GitLab), used to clone
 * PRIVATE repos during knowledge ingestion. The access token is stored ENCRYPTED
 * (AES-256-GCM; see src/lib/integrations/crypto.ts) — never plaintext. The worker
 * decrypts it at clone time.
 */
export const GitConnectionSchema = z.object({
  provider: z.enum(["github", "gitlab"]),
  /**
   * oauth (legacy): an encrypted user token. app: a GitHub App installation —
   * read-only by construction; no token is stored, one is minted per clone.
   */
  kind: z.enum(["oauth", "app"]).optional(),
  /** GitHub App installation id (kind "app"). Not a secret. */
  installationId: z.number().int().positive().optional(),
  /** Encrypted access token (ciphertext / iv / GCM tag), all base64. Absent for kind "app". */
  enc: z.object({ ct: z.string(), iv: z.string(), tag: z.string() }).optional(),
  /** The connected account handle (for display). */
  accountLogin: z.string().optional(),
  scope: z.string().optional(),
  /** Firebase UID of the admin who connected. */
  connectedBy: z.string().optional(),
  connectedAt: z.string(),
  /**
   * The repos (across the account's orgs/groups) this connection may be used for.
   * undefined = legacy connection (any repo); [] = none chosen yet (token unused).
   * See src/lib/integrations/repos.ts.
   */
  repos: z.array(GitSelectedRepoSchema).max(200).optional(),
  reposUpdatedAt: z.string().optional(),
});
export type GitConnection = z.infer<typeof GitConnectionSchema>;

/**
 * A per-tenant OAuth 2.0 connection to a social platform (X now; Instagram/LinkedIn
 * later), used to publish on the account owner's behalf. Access + refresh tokens are
 * stored ENCRYPTED (AES-256-GCM; src/lib/social/crypto.ts) — never plaintext.
 */
/** A LinkedIn Company Page the connected member administers (organization posting). */
export const LinkedInOrgSchema = z.object({
  /** `urn:li:organization:{id}` — the author URN for a page post. */
  urn: z.string(),
  name: z.string().nullable().optional(),
});
export type LinkedInOrg = z.infer<typeof LinkedInOrgSchema>;

export const SocialConnectionSchema = z.object({
  // "linkedin" = personal member posting (App 1); "linkedin_org" = Company Page posting
  // via the Community Management API (App 2, separate credentials).
  platform: z.enum(["x", "instagram", "linkedin", "linkedin_org"]),
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
  /** For a linkedin_org connection: the Company Pages the member administers (the
   *  selectable authors for a page post). Discovered from organizationAcls at connect. */
  orgs: z.array(LinkedInOrgSchema).optional(),
  scope: z.string().optional(),
  /** ISO expiry of the access token (refresh before this). */
  expiresAt: z.string().nullable().optional(),
  /** Firebase UID of the admin who connected. */
  connectedBy: z.string().optional(),
  connectedAt: z.string(),
});
export type SocialConnection = z.infer<typeof SocialConnectionSchema>;

/**
 * One colour in a brand palette. `role` (primary/secondary/accent/background/text) and
 * `estimated` (hex guessed from an uncoded swatch or image pixels rather than a printed
 * code) are optional metadata surfaced in the editor. Both are additive, so pre-existing
 * `{hex,name}` palette entries still parse unchanged.
 */
export const PaletteColorSchema = z.object({
  hex: z.string().max(9),
  name: z.string().max(60).nullable().optional(),
  role: z.string().max(40).nullable().optional(),
  estimated: z.boolean().optional(),
});
export type PaletteColor = z.infer<typeof PaletteColorSchema>;

/** Where a palette group came from (drives the review-tray / group label + badge). */
export const PaletteSourceSchema = z.enum(["manual", "pdf", "website", "ai", "logo"]);
export type PaletteSource = z.infer<typeof PaletteSourceSchema>;

/**
 * A named, source-labelled palette GROUP (the "Palettes" list in the Colours card). Kept
 * after the operator reviews an extraction (PDF / website / AI theme / logo); the primary
 * working palette stays the flat `brandKit.palette` below.
 */
export const PaletteGroupSchema = z.object({
  id: z.string().max(64),
  name: z.string().max(80),
  source: PaletteSourceSchema.nullable().optional(),
  colors: z.array(PaletteColorSchema).max(48),
});
export type PaletteGroup = z.infer<typeof PaletteGroupSchema>;

/**
 * Brand Kit — a structured brand identity AI-extracted from an uploaded brand-
 * guidelines PDF (Account → Brand). EVERY field is nullable so a sparse guideline
 * still stores partially; it feeds on-brand AI generation (email layouts + images).
 */
export const BrandKitSchema = z.object({
  /** Private-bucket ref of the source PDF (filename) + its display name. */
  pdfPath: z.string().max(300).nullable().optional(),
  pdfName: z.string().max(300).nullable().optional(),
  /** Freeform brand overview the model wrote. */
  summary: z.string().max(4000).nullable().optional(),
  /** The primary working palette ("Colour palette"). */
  palette: z.array(PaletteColorSchema).max(24).nullable().optional(),
  /**
   * Named, source-labelled palette GROUPS ("Palettes"), kept from PDF / website / AI-theme /
   * logo extraction after review. Additive: existing tenant docs simply have none. Their
   * hexes also flow into on-brand generation alongside the flat `palette` (assembleBrandContext).
   */
  palettes: z.array(PaletteGroupSchema).max(20).nullable().optional(),
  fonts: z.array(z.string().max(80)).max(12).nullable().optional(),
  tone: z.string().max(1000).nullable().optional(),
  voice: z.string().max(1000).nullable().optional(),
  /** Imagery/photography direction, e.g. "warm photographic, lots of whitespace". */
  imageryStyle: z.string().max(1000).nullable().optional(),
  logoUsage: z.string().max(1000).nullable().optional(),
  dos: z.array(z.string().max(300)).max(30).nullable().optional(),
  donts: z.array(z.string().max(300)).max(30).nullable().optional(),
  /** ISO of the last successful AI extraction. */
  extractedAt: z.string().max(40).nullable().optional(),

  /**
   * LEARNED image style — an art-director directive synthesized from the images the
   * operator marked on-brand in the Brand Kit gallery (👍 + 1–10 rating; see
   * src/lib/content/create/styleProfile.ts). Distinct from `imageryStyle` (which comes
   * from the guidelines PDF): this is a rolling signal learned from what they actually
   * approved, injected into every image prompt via assembleBrandContext. Nullable so
   * tenants without any exemplars yet simply have none.
   */
  learnedImageStyle: z.string().max(2000).nullable().optional(),
  learnedImageStyleUpdatedAt: z.string().max(40).nullable().optional(),
  learnedImageStyleSampleCount: z.number().int().nonnegative().nullable().optional(),
});
export type BrandKit = z.infer<typeof BrandKitSchema>;

/**
 * Authored, tenant-GLOBAL brand voice (Canva-style). Deliberately a TOP-LEVEL tenant field,
 * NOT part of `brandKit`: the brandKit map is replaced wholesale on every PDF re-extract and
 * manual Brand save, so keeping the voice out of it means those writes can never clobber it
 * (and it needs no preservation helper). This is operator/AI-AUTHORED, distinct from the
 * PDF-EXTRACTED `brandKit.voice`/`tone`. One voice per brand; every workspace uses it. Grounds
 * all AI text generation via `resolveBrandVoiceText` → `brandVoiceSection`/`assembleBrandContext`.
 */
export const BrandVoiceSchema = z.object({
  /** What the voice achieves + WHEN to use it (the reference's "Summary"). */
  summary: z.string().max(500).nullable().optional(),
  /** Guidance for tone / vocabulary / key messages. */
  dos: z.array(z.string().max(300)).max(12).nullable().optional(),
  /** Common mistakes to avoid. */
  donts: z.array(z.string().max(300)).max(12).nullable().optional(),
  /** Free-text "how to write in your brand voice" guidelines. */
  guidelines: z.string().max(2000).nullable().optional(),
  /** Provenance: the domain the AI generator was grounded in (if AI-authored). */
  sourceDomain: z.string().max(253).nullable().optional(),
  generatedAt: z.string().max(40).nullable().optional(),
  updatedAt: z.string().max(40).nullable().optional(),
});
export type BrandVoice = z.infer<typeof BrandVoiceSchema>;

/**
 * A named TEXT STYLE in the Brand Kit → Fonts section (the Canva-style typography rows:
 * Title / Subtitle / Heading / … / Caption). `role` is the semantic slot (the "Type"
 * dropdown); `fontFamily` is a family name from the curated list or an uploaded custom
 * font (see src/lib/content/fonts.ts). All presentation fields are nullable so a partially
 * configured style still stores. `id` is a stable client-generated uuid used as the React key.
 */
export const TextStyleRoleSchema = z.enum([
  "title",
  "subtitle",
  "heading",
  "subheading",
  "sectionHeader",
  "body",
  "quote",
  "caption",
]);
export type TextStyleRole = z.infer<typeof TextStyleRoleSchema>;

export const TextStyleSchema = z.object({
  id: z.string().max(64),
  name: z.string().max(60),
  role: TextStyleRoleSchema,
  fontFamily: z.string().max(80).nullable().optional(),
  size: z.number().int().min(8).max(200).nullable().optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
});
export type TextStyle = z.infer<typeof TextStyleSchema>;

/**
 * Authored, tenant-GLOBAL typography (Brand Kit → Fonts). A TOP-LEVEL tenant field (NOT part of
 * `brandKit`), mirroring `brandVoice`: `brandKit` is replaced wholesale on every PDF re-extract /
 * Brand save, so keeping typography out of it means those writes can never clobber it. The
 * uploaded font FILES live in the separate `brand_fonts` collection; this holds the STYLE config
 * only. Grounds on-brand generation via assembleBrandContext (typography lines). Every field is
 * optional so tenants without any typography simply have none.
 */
export const BrandTypographySchema = z.object({
  styles: z.array(TextStyleSchema).max(24).nullable().optional(),
  /** Free-text "how to use the brand's type" guidance (the Fonts → Guidelines entry). */
  guidelines: z.string().max(2000).nullable().optional(),
  updatedAt: z.string().max(40).nullable().optional(),
});
export type BrandTypography = z.infer<typeof BrandTypographySchema>;

/**
 * Learned POST-PERFORMANCE patterns — the abstract "what performs on this channel" directive the
 * Distribute feedback loop synthesizes from PROMOTED clusters (repeatable, above-baseline posts).
 * Top-level (NOT nested in brandKit) for clobber-safety, mirroring brandVoice. Per-channel because
 * a LinkedIn pattern ≠ an X pattern. Each channel fragment is independently versioned + revertable
 * (the "Content Steering" transparency surface); `frozen` blocks auto-promotion after an operator
 * reverts to a past version, until they resume learning.
 */
export const LearnedPatternRuleSchema = z.object({
  text: z.string().max(200),
  /** How many distinct posts support this move. */
  support: z.number().int().nonnegative().default(0),
  /** Mean baseline-relative lift of the supporting posts (reward units, ~−1..1). */
  meanLift: z.number().default(0),
});
export const LearnedChannelPatternsSchema = z.object({
  /** The abstract directive injected into generation (null = nothing learned yet). */
  directive: z.string().max(1500).nullable().optional(),
  perform: z.array(LearnedPatternRuleSchema).max(8).default([]),
  avoid: z.array(LearnedPatternRuleSchema).max(6).default([]),
  sampleCount: z.number().int().nonnegative().default(0),
  championScore: z.number().nullable().optional(),
  /** The version currently LIVE for this channel (what injection reads). */
  activeVersion: z.number().int().nonnegative().default(0),
  /** Highest version ever synthesized for this channel. */
  latestVersion: z.number().int().nonnegative().default(0),
  /** Set by a revert — the version the operator pinned. */
  pinnedVersion: z.number().int().nonnegative().nullable().optional(),
  /** When true, auto-promotion is paused (an operator reverted); resume clears it. */
  frozen: z.boolean().default(false),
  updatedAt: z.string().max(40).nullable().optional(),
});
export const LearnedPostPatternsSchema = z.object({
  channelFragments: z.record(z.string(), LearnedChannelPatternsSchema).default({}),
  updatedAt: z.string().max(40).nullable().optional(),
});
export type LearnedPatternRule = z.infer<typeof LearnedPatternRuleSchema>;
export type LearnedChannelPatterns = z.infer<typeof LearnedChannelPatternsSchema>;
export type LearnedPostPatterns = z.infer<typeof LearnedPostPatternsSchema>;

/**
 * Email style — the header band on branded emails (logo, optional company name, header
 * colour) plus the button colour. TOP-LEVEL like brandVoice: `brandKit` is replaced wholesale
 * on a PDF re-extract / Brand save, and the colours are COPIED here, so a re-extract never
 * silently restyles live email. Strict on write (EmailStyleInputSchema, used by the admin PUT
 * and the setter); lenient on read (TenantSchema catches a damaged value as "none", because
 * every tenant read — incl. the delivery crons — parses the whole doc).
 *
 * Header options (EMAIL_HEADER_OPTIONS_ENABLED): a gradient's second colour, a forced header
 * text colour, and a header image (a banner in place of the logo and name). Stored only when
 * set: absent = a solid header / Auto text / the colour header. Absent in a Save = keep what's
 * stored. A damaged stored option drops alone; the band still draws (a damaged image = Colour).
 * The theme (EMAIL_THEMES_ENABLED) works the same way: stored only when it isn't Classic with
 * the system font, kept when a Save leaves it out, and dropped alone when damaged.
 */
export const EMAIL_STYLE_LIMITS = { logoWidth: 200, logoHeight: 48, companyName: 80 } as const;

/**
 * Email header images (a banner in place of the logo and name): the most pixels a stored one
 * may have (the page downsizes to 1200 wide first), its byte cap, and how many a tenant keeps.
 */
export const EMAIL_HEADER_IMAGE_LIMITS = { width: 1200, height: 2400, bytes: 1024 * 1024, count: 20 } as const;

/** A logo file the email header may use: `<uuid>.png|jpg|jpeg`. WebP is left out — Outlook can't show it. */
export const EMAIL_LOGO_FILENAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpe?g)$/;

/** Control, invisible-format (e.g. U+2063, U+202E) and line/paragraph separator characters. */
export const HIDDEN_NAME_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** Markup a company name may not carry: HTML, {{tokens}} and Mailchimp *|TAGS|*. */
const NAME_MARKUP = /[<>]|\{\{|\}\}|\*\||\|\*/;

export const HexColorSchema = z
  .string()
  .toLowerCase()
  .regex(/^#[0-9a-f]{6}$/, "Use a #rrggbb colour");

/** Clean it first with cleanCompanyName (src/lib/email/emailStyle.ts); this only validates. */
export const CompanyNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(EMAIL_STYLE_LIMITS.companyName)
  .refine((s) => !HIDDEN_NAME_CHARS.test(s), "The name has hidden characters")
  .refine((s) => !NAME_MARKUP.test(s), "The name can't contain <, >, {{ }} or *| |*");

/** A logo by reference (never a URL — that's derived at render time) with its display size. */
export const EmailStyleLogoSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  filename: z.string().regex(EMAIL_LOGO_FILENAME),
  width: z.number().int().min(1).max(EMAIL_STYLE_LIMITS.logoWidth),
  height: z.number().int().min(1).max(EMAIL_STYLE_LIMITS.logoHeight),
});
export type EmailStyleLogo = z.infer<typeof EmailStyleLogoSchema>;

/**
 * A header image by reference (never a URL — that's derived at render time): a `header` brand
 * asset, with the pixel size read from the file at upload. PNG/JPEG only, as for logos.
 */
export const EmailStyleHeaderImageSchema = z.object({
  /** The brand_assets row id. */
  id: EmailStyleLogoSchema.shape.id,
  filename: z.string().regex(EMAIL_LOGO_FILENAME),
  width: z.number().int().min(1).max(EMAIL_HEADER_IMAGE_LIMITS.width),
  height: z.number().int().min(1).max(EMAIL_HEADER_IMAGE_LIMITS.height),
});
export type EmailStyleHeaderImage = z.infer<typeof EmailStyleHeaderImageSchema>;

/** The band's text colour: "auto" is black or white, whichever reads better across the band. */
export const HEADER_TEXT_CHOICES = ["auto", "white", "black"] as const;
export const HeaderTextSchema = z.enum(HEADER_TEXT_CHOICES);
export type HeaderTextChoice = z.infer<typeof HeaderTextSchema>;

/**
 * Email theme (EMAIL_THEMES_ENABLED): one of four looks (page colour, card corners, button
 * shape, spacing: src/lib/email/emailThemes.ts) and a heading and a body font. Fonts are by id,
 * never CSS: the stacks are in src/lib/email/emailFonts.ts. The first five are installed almost
 * everywhere; the rest are web fonts, which only some inboxes load (others see a safe stack).
 * No theme = Classic with the system font, today's look.
 */
export const EMAIL_THEME_PRESETS = ["classic", "modern", "editorial", "friendly"] as const;
export const EmailThemePresetSchema = z.enum(EMAIL_THEME_PRESETS);
export type EmailThemePreset = z.infer<typeof EmailThemePresetSchema>;

export const EMAIL_FONT_IDS = [
  "system",
  "arial",
  "georgia",
  "verdana",
  "trebuchet",
  "inter",
  "poppins",
  "nunito",
  "montserrat",
  "lora",
  "playfair-display",
] as const;
export const EmailFontIdSchema = z.enum(EMAIL_FONT_IDS);
export type EmailFontId = z.infer<typeof EmailFontIdSchema>;

/** A theme, strictly (the Save). A font left out is the preset's. */
export const EmailThemeSchema = z
  .object({
    preset: EmailThemePresetSchema,
    headingFont: EmailFontIdSchema.optional(),
    bodyFont: EmailFontIdSchema.optional(),
  })
  .strict();
export type EmailTheme = z.infer<typeof EmailThemeSchema>;

/** A stored theme, read per field: an unknown font reads as the preset's; an unknown preset fails (the theme drops). */
export const StoredEmailThemeSchema = z.object({
  preset: EmailThemePresetSchema,
  headingFont: EmailFontIdSchema.optional().catch(undefined),
  bodyFont: EmailFontIdSchema.optional().catch(undefined),
});

export const EmailStyleInputSchema = z.object({
  logo: EmailStyleLogoSchema.nullable(),
  /** null = the logo alone (or the workspace's sender name when there's no logo). */
  companyName: CompanyNameSchema.nullable(),
  headerColor: HexColorSchema,
  accentColor: HexColorSchema,
  /** The band fades from headerColor to this; null = solid. Absent = keep what's stored. */
  headerGradientColor: HexColorSchema.nullable().optional(),
  /** Absent = keep what's stored. */
  headerText: HeaderTextSchema.optional(),
  /** A banner in place of the logo and name; null = the colour header. Absent = keep what's stored. */
  headerImage: EmailStyleHeaderImageSchema.nullable().optional(),
  /** A look and two fonts; null = Classic with the system font (no theme). Absent = keep what's stored. */
  theme: EmailThemeSchema.nullable().optional(),
});
export type EmailStyleInput = z.infer<typeof EmailStyleInputSchema>;

export const StoredEmailStyleSchema = EmailStyleInputSchema.extend({
  updatedAt: z.string().max(40).optional(),
  /** Firebase UID of the admin who saved it. */
  updatedBy: z.string().max(128).optional(),
  // Never stored as a default (null, "auto"), and read per field: a damaged one drops alone.
  headerGradientColor: HexColorSchema.optional().catch(undefined),
  headerText: z.enum(["white", "black"]).optional().catch(undefined),
  /** Present = Image mode; absent = the colour header. A damaged one (say a .webp) reads as Colour. */
  headerImage: EmailStyleHeaderImageSchema.optional().catch(undefined),
  /** Present = a theme other than Classic with the system font. A damaged one reads as no theme. */
  theme: StoredEmailThemeSchema.optional().catch(undefined),
});
export type StoredEmailStyle = z.infer<typeof StoredEmailStyleSchema>;

/**
 * A journey's own look (EMAIL_JOURNEY_STYLE_ENABLED), for lifecycle journeys: product journeys,
 * and launch welcome journeys on the new engine. Its header and button colours, and a gradient
 * and header text (these two draw only with EMAIL_HEADER_OPTIONS_ENABLED), in place of the
 * brand's; the brand's logo, name and theme stay, and there's never a banner. No style = the
 * brand's Email style. The gradient and text are stored only when set (absent = solid / Auto).
 * Strict on write (JourneyEmailStyleSchema: the human draft route and Vizzy's kind); lenient on
 * read (StoredJourneyStyleSchema), because the style is echoed in every draft, journey and export
 * parse, and a damaged one must read as the brand's rather than fail the journey around it.
 */
export const JourneyEmailStyleSchema = z
  .object({
    headerColor: HexColorSchema,
    accentColor: HexColorSchema,
    /** The header fades from headerColor to this; absent = solid. */
    headerGradientColor: HexColorSchema.optional(),
    /** Absent = Auto. */
    headerText: z.enum(["white", "black"]).optional(),
  })
  .strict();
export type JourneyEmailStyle = z.infer<typeof JourneyEmailStyleSchema>;

/** A stored journey style: a damaged gradient or text drops alone; anything else damaged reads as none. */
export const StoredJourneyStyleSchema = z
  .object({
    headerColor: HexColorSchema,
    accentColor: HexColorSchema,
    headerGradientColor: HexColorSchema.optional().catch(undefined),
    headerText: z.enum(["white", "black"]).optional().catch(undefined),
  })
  .optional()
  .catch(undefined);
export type StoredJourneyStyle = NonNullable<z.infer<typeof StoredJourneyStyleSchema>>;

export const EMAIL_STYLE_SUGGESTION_LIMITS = { brief: 500, notes: 5, note: 200 } as const;

/**
 * An Email style Vizzy suggested (from chat or the brand kit), waiting for an admin to Review
 * and Save it. Sends never read it. It has no logo size: the page measures the logo on Review.
 * `suggestedAt` is the compare-and-clear key, so a Save or Dismiss never clears a newer one.
 * The header options are stored only when set (absent = solid / Auto / the colour header), and
 * strictly: a damaged one reads the whole suggestion as none, as for any other field. A header
 * image is by id only: its file and size come from the row on Review. The theme
 * (EMAIL_THEMES_ENABLED) likewise: stored only when it isn't Classic with the system font,
 * without the look's own fonts, and strictly.
 */
export const EmailStyleSuggestionSchema = z.object({
  logoId: EmailStyleLogoSchema.shape.id.nullable(),
  companyName: CompanyNameSchema.nullable(),
  headerColor: HexColorSchema,
  accentColor: HexColorSchema,
  /** The header fades from headerColor to this; absent = solid. */
  headerGradientColor: HexColorSchema.optional(),
  /** Absent = Auto. */
  headerText: z.enum(["white", "black"]).optional(),
  /** A header image (a `header` brand asset's id) in place of the logo and name; absent = the colour header. */
  headerImageId: EmailStyleLogoSchema.shape.id.optional(),
  /** A look and two fonts, as the Email style stores one; absent = Classic with the system font. */
  theme: EmailThemeSchema.optional(),
  source: z.enum(["brand_kit", "chat"]),
  /** What was asked for, in the asker's words. */
  brief: z.string().max(EMAIL_STYLE_SUGGESTION_LIMITS.brief),
  notes: z
    .array(z.string().max(EMAIL_STYLE_SUGGESTION_LIMITS.note))
    .max(EMAIL_STYLE_SUGGESTION_LIMITS.notes),
  /** Firebase UID of who asked Vizzy, or "agent". Never shown on the page or sent to Vizzy. */
  suggestedBy: z.string().min(1).max(128),
  suggestedAt: z.string().min(1).max(40),
});
export type EmailStyleSuggestion = z.infer<typeof EmailStyleSuggestionSchema>;

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
  /** AI-extracted brand kit (from an uploaded guidelines PDF); powers on-brand generation. */
  brandKit: BrandKitSchema.optional(),
  /** Authored, tenant-global brand voice (Summary/Do/Don't/guidelines); grounds all AI copy. */
  brandVoice: BrandVoiceSchema.optional(),
  /** Authored, tenant-global typography (Brand Kit → Fonts text styles + guidelines); grounds
   *  on-brand generation. Top-level (like brandVoice) so a PDF re-extract can't clobber it. */
  brandTypography: BrandTypographySchema.optional(),
  /** Learned post-performance patterns (per-channel, versioned) from the Distribute feedback loop. */
  learnedPostPatterns: LearnedPostPatternsSchema.optional(),
  /** Email style (header band + button colour). A damaged value reads as none, never a throw. */
  emailStyle: StoredEmailStyleSchema.optional().catch(undefined),
  /** A pending Email style suggestion from Vizzy, for an admin to apply. Damaged reads as none. */
  emailStyleSuggestion: EmailStyleSuggestionSchema.optional().catch(undefined),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Tenant = z.infer<typeof TenantSchema>;
