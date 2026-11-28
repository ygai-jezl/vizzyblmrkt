import { z } from "zod";
import { CONSENT_HOW, CONSENT_NOTE_MAX, CONSENT_STATES } from "@/lib/ontology/consent";
import { FieldValuesSchema } from "./recordField";
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
  /** The sign-up's language, a supported base code (LANGUAGE_READERS_ENABLED). */
  locale: z.string().max(16).optional(),
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
  /** The product user's language, a supported base code (LANGUAGE_READERS_ENABLED). */
  locale: z.string().max(16).optional(),
});
export type PersonProductLink = z.infer<typeof PersonProductLinkSchema>;

/** Brand-wide and per-category opt-outs for the address, as of the last full sync. */
export const PersonOptOutsSchema = z.object({
  /** The strongest brand-wide block: a bounce, then a complaint, then an unsubscribe. */
  blocked: z.enum(["unsubscribe", "spam", "hard_bounce"]).nullable().default(null),
  categories: z.array(z.string()).default([]),
});
export type PersonOptOuts = z.infer<typeof PersonOptOutsSchema>;

const noAt = (v: string) => !v.includes("@");
/** A team member's user id or an agent action's id: never an address. */
const ActorId = z.string().min(1).max(200).refine(noAt, { message: "an id, never an address" });

/**
 * Where someone added by hand came in: the People list's form, ⌘K, Vizzy's draft, or a list an
 * admin pasted on People (RAISE_PASTE_ENABLED). New person's own form never sends "paste"
 * (NEW_PERSON_VIA in src/lib/audience/newPerson.ts).
 */
export const ADDED_VIA = ["form", "palette", "vizzy", "paste"] as const;
export type AddedVia = (typeof ADDED_VIA)[number];

/**
 * Who added a person by hand (piece B, New person): a team member by user id, or Vizzy's
 * suggestion (its agent action id) once someone confirmed it. Its presence makes the person a
 * source of their own, whatever any switch says: no sync deletes them, renames them or marks
 * them deleted, and a later sign-up never replaces the name that was typed. `source` is set only
 * with `via: "paste"`: the admin's answer to "Where is this list from?", so the team can tell
 * someone where their details were found. A company added from a pasted list carries one too.
 */
export const ContactAddedBySchema = z.object({
  kind: z.enum(["member", "agent"]),
  id: ActorId,
  at: z.string(),
  via: z.enum(ADDED_VIA),
  source: z.string().trim().min(1).max(80).optional(),
});
export type ContactAddedBy = z.infer<typeof ContactAddedBySchema>;

/**
 * The consent the team recorded for one purpose: the current state. Each change is also a
 * consent.recorded event in the event history (src/lib/ontology/consent.ts), which is the proof.
 */
export const ContactConsentEntrySchema = z.object({
  state: z.enum(CONSENT_STATES),
  /** How they agreed, as a short code (the New person form owns the list). */
  how: z.string().regex(CONSENT_HOW),
  note: z.string().max(CONSENT_NOTE_MAX).nullable(),
  /** The team member who recorded it, by user id. */
  recordedBy: ActorId,
  /** When it was recorded. */
  at: z.string(),
  /** When the person agreed, when that is known and differs from when it was recorded. */
  agreedAt: z.string().nullable(),
});
export type ContactConsentEntry = z.infer<typeof ContactConsentEntrySchema>;

/** Recorded consent by purpose. Only marketing email is recorded today, and only for people added by hand. */
export const ContactConsentSchema = z.object({
  marketing_email: ContactConsentEntrySchema.optional(),
});
export type ContactConsent = z.infer<typeof ContactConsentSchema>;

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

  /** Set only on someone added by hand: who added them, when and from where. */
  addedBy: ContactAddedBySchema.optional(),
  /** Consent the team recorded for someone added by hand. Reach is yes only with marketing email granted here. */
  consent: ContactConsentSchema.optional(),

  /**
   * The brand's own fields (AUDIENCE_FIELDS_ENABLED), by field id: written only by
   * src/lib/tenant/recordFieldWrites.ts, never by a sync. Archived fields keep their values here.
   * Exempt from automatic indexing (firestore.indexes.json), like products and optOuts.
   */
  fields: FieldValuesSchema.optional(),

  // ---- The person record (AUDIENCE_PERSON_LINKS_ENABLED). Derived from the person's
  // sign-ups, product users and opt-outs by src/lib/audience/personSync.ts, and safe
  // to rebuild at any time. Absent on contacts no sync has reached yet.

  /** Their user records in connected products. */
  products: z.array(PersonProductLinkSchema).optional(),
  /**
   * Tags the People list filters on with one array-contains: `all`, `launch:any`,
   * `launch:<campaignId>`, `via:form`, `via:site`, `product:any`, `product:<connectionId>`,
   * `stage:<connectionId>:<stage>`, `quiet:<connectionId>`, `group:<connectionId>:<id>`, and
   * `added:hand` for someone added by hand. `field:<fieldId>:<optionId>` (a select, a status,
   * each option of a multi select) and `field:<fieldId>:yes` (a ticked checkbox) belong to the
   * field writer, at most 50, and only while the person is in Everyone (`all`): a sync keeps
   * them, and `added:hand`, as they are (isCarriedTag in src/lib/audience/personLinks.ts). A
   * group's id is the product's own, so it may hold `.` and `:`.
   */
  memberOf: z.array(z.string()).optional(),
  /** The best reach across their sources, unless a brand-wide opt-out stops everything. */
  reach: z.enum(["yes", "limited", "no"]).optional(),
  optOuts: PersonOptOutsSchema.optional(),
  /** When they were last active anywhere we can see. */
  activeAt: z.string().optional(),
  /**
   * Their language (LANGUAGE_READERS_ENABLED): the locale of their newest live sign-up or product
   * user that has one, a supported base code. Null or absent when we don't know it. Readers per
   * language are counted on it (src/lib/i18n/languageReaders.ts).
   */
  language: z.string().max(16).nullable().optional(),
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
