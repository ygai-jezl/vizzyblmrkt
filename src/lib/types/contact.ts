import { z } from "zod";
import { UtmSchema } from "./signup";

/**
 * Contact — the Unified CRM person record. Lives in the tenant-scoped regional
 * `contacts` collection (PII residency, like signups). Deduped across every
 * launch by `contactKey` (normalizeEmail(email) ?? phone), so one person who
 * joined three waitlists is ONE contact with three campaign links. Built to be
 * trivially enrichable: a structured `enrichment` sub-object + open-ended
 * future fields, never a flat smear. See src/lib/crm/contactService.ts.
 */
export const ContactStatus = z.enum(["active", "offboarded", "deleted"]);
export type ContactStatus = z.infer<typeof ContactStatus>;

/**
 * Legal-basis / consent tracking (§H2). NO outbound use (enrichment, audience
 * sync, engagement polling) is permitted for any contact below "verified_active"
 * — matching the existing verified-only MailChimp audience-sync posture.
 */
export const ConsentStatus = z.enum([
  "none",
  "unverified_signup",
  "verified_active",
  "deleted",
]);
export type ConsentStatus = z.infer<typeof ConsentStatus>;

/** Provenance of one campaign this person signed up to — the multi-campaign link. */
export const ContactCampaignLinkSchema = z.object({
  campaignId: z.string(),
  signupId: z.string(), // deterministic signup id (sig_…)
  status: z.string(), // mirror of signup.status at link time
  referralToken: z.string().nullable().optional(),
  amountReferred: z.number().int().nonnegative().default(0),
  score: z.number().int().nullable().optional(),
  joinedAt: z.string(), // signup.createdAt
  /** How they joined this launch: its page or widget ("form"), or the brand's own site ("site"). */
  joinedVia: z.enum(["form", "site"]).nullable().optional(),
});
export type ContactCampaignLink = z.infer<typeof ContactCampaignLinkSchema>;

export const ContactEnrichmentStatus = z.enum([
  "none", // not corporate / never attempted
  "pending", // queued
  "processing",
  "enriched", // company profile attached
  "skipped", // free provider / no email / region-gated / unconfigured
  "failed",
]);
export type ContactEnrichmentStatus = z.infer<typeof ContactEnrichmentStatus>;

/**
 * Snapshot of company facts denormalised onto the contact for list rendering;
 * the canonical record is companies/{companyId}. Structured + provenance-stamped
 * so adding new enrichment sources later is a field addition, not a refactor.
 */
export const ContactEnrichmentSchema = z.object({
  status: ContactEnrichmentStatus,
  companyId: z.string().nullable().optional(),
  domain: z.string().nullable().optional(), // canonical registrable domain
  source: z.enum(["agent1", "manual", "import"]).nullable().optional(),
  model: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  enrichedAt: z.string().nullable().optional(),
  lastError: z.string().nullable().optional(),
});
export type ContactEnrichment = z.infer<typeof ContactEnrichmentSchema>;

/** A trimmed form answer carried onto the contact (question + answer only). */
export const ContactAnswerSchema = z.object({
  question_value: z.string(),
  answer_value: z.string(),
});

/**
 * The person record's link to one of their user records in a connected product
 * (AUDIENCE_PERSON_LINKS_ENABLED): what the People list filters and shows without
 * reading the product user. Derived; src/lib/audience/personSync.ts keeps it.
 */
export const PersonProductLinkSchema = z.object({
  connectionId: z.string(),
  productUserId: z.string(),
  stage: z.enum(["new", "onboarding", "stuck", "activated", "member"]),
  /** Not active for the product's quiet clock or longer (the days follow from lastActiveAt). */
  quiet: z.boolean().default(false),
  activated: z.boolean().default(false),
  signedUpAt: z.string().nullable().optional(),
  lastActiveAt: z.string().nullable().optional(),
  /** Whether this product's rules let us email them: yes, service emails only or some categories ("limited"), or no. */
  reach: z.enum(["yes", "limited", "no"]),
  /** The product's groups they belong to (workspaces, teams, households: the product's own word). */
  groups: z.array(z.string()).default([]),
});
export type PersonProductLink = z.infer<typeof PersonProductLinkSchema>;

/** Brand-wide and per-category opt-outs for the address, as of the last full sync. */
export const PersonOptOutsSchema = z.object({
  /** The strongest brand-wide block: a bounce, then a complaint, then an unsubscribe. */
  blocked: z.enum(["unsubscribe", "spam", "hard_bounce"]).nullable().default(null),
  categories: z.array(z.string()).default([]),
});
export type PersonOptOuts = z.infer<typeof PersonOptOutsSchema>;

export const ContactSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  /** The dedupe key: normalizeEmail(email) ?? phone. Immutable for this contact. */
  contactKey: z.string(),

  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  firstName: z.string().nullable().optional(),
  lastName: z.string().nullable().optional(),

  status: ContactStatus,
  /** True once any signup for this person reached verified_active. */
  verified: z.boolean().default(false),
  /** Legal basis for holding/using this record (§H2). */
  consentStatus: ConsentStatus,

  /** Canonical registrable domain of the email (never a raw subdomain). */
  emailDomain: z.string().nullable().optional(),
  isCorporateDomain: z.boolean().default(false),

  /** Association → companies/{id}. */
  companyId: z.string().nullable().optional(),

  // Multi-campaign association (the contact ↔ signups link, denormalised).
  campaigns: z.array(ContactCampaignLinkSchema).default([]),
  campaignIds: z.array(z.string()).default([]), // array-contains filter + index
  totalReferred: z.number().int().nonnegative().default(0),

  // Best signup-derived payload (latest non-null wins on merge).
  utm: UtmSchema.optional(),
  referrerUrl: z.string().nullable().optional(),
  answers: z.array(ContactAnswerSchema).optional(),

  // Structured enrichment sub-object + status + provenance.
  enrichment: ContactEnrichmentSchema,

  /** Lowercased name/email/domain fragments for array-contains search (§H6). */
  searchTokens: z.array(z.string()).default([]),

  /** Storage-limitation purge boundary (nullable = keep). */
  retentionUntil: z.string().nullable().optional(),

  // ---- The person record (AUDIENCE_PERSON_LINKS_ENABLED). Derived from the person's
  // sign-ups, product users and opt-outs by src/lib/audience/personSync.ts, and safe
  // to rebuild at any time. Absent on contacts no sync has reached yet.

  /** Their user records in connected products. */
  products: z.array(PersonProductLinkSchema).optional(),
  /**
   * Tags the People list filters on with one array-contains: `all`, `launch:any`,
   * `launch:<campaignId>`, `via:form`, `via:site`, `product:any`, `product:<connectionId>`,
   * `stage:<connectionId>:<stage>`, `quiet:<connectionId>`, `group:<connectionId>:<id>`.
   */
  memberOf: z.array(z.string()).optional(),
  /** The best reach across their sources, unless a brand-wide opt-out stops everything. */
  reach: z.enum(["yes", "limited", "no"]).optional(),
  optOuts: PersonOptOutsSchema.optional(),
  /** When they were last active anywhere we can see. */
  activeAt: z.string().optional(),
  /** The list's order: `activeAt|id`, unique, so a page never splits people who share a time. */
  sortKey: z.string().optional(),
  /** When the tags, reach or a product's stage last changed: what segments will listen to. */
  changedAt: z.string().optional(),
  /** A write path owes this person a sync; the lifecycle tick drains these. */
  needsSync: z.boolean().optional(),

  firstSeenAt: z.string(),
  updatedAt: z.string(),
  createdAt: z.string(),
});
export type Contact = z.infer<typeof ContactSchema>;
