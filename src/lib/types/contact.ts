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

  firstSeenAt: z.string(),
  updatedAt: z.string(),
  createdAt: z.string(),
});
export type Contact = z.infer<typeof ContactSchema>;
