import { forTenant, TenantIsolationError } from "@/lib/tenant";
import type { TenantContext, FirestoreLike } from "@/lib/tenant/types";
import type { Campaign } from "@/lib/types/campaign";
import type { Signup } from "@/lib/types/signup";
import type {
  Contact,
  ContactCampaignLink,
  ContactStatus,
  ConsentStatus,
  ContactEnrichmentStatus,
} from "@/lib/types/contact";
import { normalizeEmail } from "@/lib/waitlist/identifiers";
import { isPublicEmailProvider } from "@/lib/domains/registrableDomain";
import { deterministicContactId, deterministicCompanyId, domainFromEmail } from "./identifiers";
import { buildSearchTokens } from "./searchTokens";
import { enqueueContactEnrich } from "./enrichmentQueue";

export interface UpsertContactResult {
  contact: Contact;
  created: boolean;
  /** True when the caller should enqueue a contact_enrich job for this contact. */
  shouldEnrich: boolean;
}

export interface UpsertContactOptions {
  db?: FirestoreLike;
  now?: string;
}

/** Person-level fields derived from a signup (the dedupe key + corporate/consent state). */
interface Derived {
  email: string | null;
  phone: string | null;
  contactKey: string | null;
  emailDomain: string | null;
  isCorporate: boolean;
  companyId: string | null;
  verified: boolean;
  consent: ConsentStatus;
}

function derive(ctx: TenantContext, signup: Signup): Derived {
  const email = signup.email ? normalizeEmail(signup.email) : null;
  const phone = signup.phone?.trim() || null;
  const contactKey = email ?? phone;
  const emailDomain = email ? domainFromEmail(email) : null;
  const isCorporate = !!email && !!emailDomain && !isPublicEmailProvider(email);
  const companyId =
    isCorporate && emailDomain ? deterministicCompanyId(ctx.tenantId, emailDomain) : null;
  const verified = signup.status === "verified_active";
  const consent: ConsentStatus = verified ? "verified_active" : "unverified_signup";
  return { email, phone, contactKey, emailDomain, isCorporate, companyId, verified, consent };
}

function linkFromSignup(signup: Signup): ContactCampaignLink {
  return {
    campaignId: signup.campaignId,
    signupId: signup.id,
    status: signup.status,
    referralToken: signup.referralToken ?? null,
    amountReferred: signup.amountReferred ?? 0,
    score: typeof signup.score === "number" ? signup.score : null,
    joinedAt: signup.createdAt,
  };
}

function tokensFor(c: {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  emailDomain?: string | null;
}): string[] {
  return buildSearchTokens([c.firstName, c.lastName, c.email, c.emailDomain]);
}

/** Initial enrichment status: only corporate+verified contacts are eligible. */
function initialEnrichmentStatus(d: Derived): ContactEnrichmentStatus {
  if (d.isCorporate) return d.verified ? "pending" : "none";
  return d.email ? "skipped" : "none";
}

/** Never downgrade a contact's consent (except an explicit erasure elsewhere). */
function higherConsent(existing: ConsentStatus, next: ConsentStatus): ConsentStatus {
  if (existing === "deleted") return existing; // erased contacts stay erased
  if (existing === "verified_active") return existing;
  return next;
}

/**
 * The contact's lifecycle status, derived from ALL its campaign links. A person
 * is "active" while any signup is live (verified or unverified), "offboarded"
 * once every live signup has been offboarded, and "deleted" only when no links
 * remain (the operational signup purge — PII erasure is the separate GDPR
 * `contact_erase` path, which sets status independently). This keeps an
 * offboarded person fully present in the CRM, just flagged.
 */
export function recomputeContactStatus(
  links: ReadonlyArray<{ status: string }>,
): ContactStatus {
  if (links.some((l) => l.status === "verified_active" || l.status === "unverified")) {
    return "active";
  }
  if (links.some((l) => l.status === "offboarded")) return "offboarded";
  return "deleted";
}

/**
 * Upsert the Unified-CRM contact for a signup. Deduped across campaigns by
 * contactKey (normalizeEmail(email) ?? phone). Returns null when there is
 * nothing to key on (no email and no phone).
 *
 * Idempotent: deterministic tenant-hashed id + atomic create; on collision it
 * merges (campaign links keyed by campaignId, arrays unioned, scalars
 * latest-non-null-wins, consent never downgraded). MVP is best-effort
 * read-merge-write (matching the referral-credit posture); the keyed merge makes
 * a concurrent double-signup self-heal on the next signup/verify. Hardening
 * (§H5): wrap the read-merge-write in a regional transaction if link races
 * appear in practice.
 */
export async function upsertContactFromSignup(
  ctx: TenantContext,
  _campaign: Campaign,
  signup: Signup,
  opts: UpsertContactOptions = {},
): Promise<UpsertContactResult | null> {
  const d = derive(ctx, signup);
  if (!d.contactKey) return null; // phone-only with no phone & no email → nothing to dedupe on

  const repo = forTenant(ctx, opts.db);
  const id = deterministicContactId(ctx.tenantId, d.contactKey);
  const now = opts.now ?? new Date().toISOString();
  const link = linkFromSignup(signup);

  const enrichmentStatus = initialEnrichmentStatus(d);
  const createData = {
    contactKey: d.contactKey,
    email: d.email,
    phone: d.phone,
    firstName: signup.firstName ?? null,
    lastName: signup.lastName ?? null,
    status: "active" as const,
    verified: d.verified,
    consentStatus: d.consent,
    emailDomain: d.emailDomain,
    isCorporateDomain: d.isCorporate,
    companyId: d.companyId,
    campaigns: [link],
    campaignIds: [signup.campaignId],
    totalReferred: link.amountReferred,
    utm: signup.utm,
    referrerUrl: signup.referrerUrl ?? null,
    answers: signup.answers?.map((a) => ({
      question_value: a.question_value,
      answer_value: a.answer_value,
    })),
    enrichment: {
      status: enrichmentStatus,
      companyId: d.companyId,
      domain: d.emailDomain,
    },
    searchTokens: tokensFor({
      firstName: signup.firstName,
      lastName: signup.lastName,
      email: d.email,
      emailDomain: d.emailDomain,
    }),
    retentionUntil: null,
    firstSeenAt: now,
    updatedAt: now,
    createdAt: now,
  };

  try {
    const contact = await repo.contacts.create(id, createData as never);
    return { contact, created: true, shouldEnrich: d.isCorporate && d.verified };
  } catch (err) {
    if (!(err instanceof TenantIsolationError)) throw err;
  }

  // Collision → this person already has a contact. Merge.
  const existing = await repo.contacts.getById(id);
  if (!existing) throw new TenantIsolationError(`contacts/${id} vanished mid-upsert`);
  // Defence in depth: getById already re-checks tenant, but never merge a doc
  // that isn't ours (deterministic ids are globally colliding).
  if (existing.tenantId !== ctx.tenantId) {
    throw new TenantIsolationError(`contacts/${id} belongs to another tenant`);
  }

  const campaigns = [
    ...existing.campaigns.filter((c) => c.campaignId !== signup.campaignId),
    link,
  ];
  const campaignIds = Array.from(new Set([...existing.campaignIds, signup.campaignId]));
  const totalReferred = campaigns.reduce((s, c) => s + (c.amountReferred ?? 0), 0);

  const firstName = signup.firstName ?? existing.firstName ?? null;
  const lastName = signup.lastName ?? existing.lastName ?? null;
  const email = existing.email ?? d.email;
  const phone = existing.phone ?? d.phone;
  const emailDomain = existing.emailDomain ?? d.emailDomain;
  const isCorporate = existing.isCorporateDomain || d.isCorporate;
  const companyId = existing.companyId ?? d.companyId;
  const verified = existing.verified || d.verified;
  const consentStatus = higherConsent(existing.consentStatus, d.consent);

  // Promote enrichment to pending when this person is now corporate + verified
  // and we haven't already enriched/started — never downgrade enriched/processing.
  const wasTerminal =
    existing.enrichment.status === "enriched" ||
    existing.enrichment.status === "processing";
  const enrichNow = isCorporate && verified && !wasTerminal;
  const nextEnrichment = enrichNow
    ? { ...existing.enrichment, status: "pending" as const, companyId, domain: emailDomain }
    : existing.enrichment;

  const patch = {
    firstName,
    lastName,
    email,
    phone,
    verified,
    consentStatus,
    emailDomain,
    isCorporateDomain: isCorporate,
    companyId,
    campaigns,
    campaignIds,
    totalReferred,
    // Recompute lifecycle status across all links so a re-signup/verify (and the
    // offboard/delete sync below) keeps the top-level status honest.
    status: recomputeContactStatus(campaigns),
    utm: signup.utm ?? existing.utm,
    referrerUrl: signup.referrerUrl ?? existing.referrerUrl ?? null,
    enrichment: nextEnrichment,
    searchTokens: tokensFor({ firstName, lastName, email, emailDomain }),
    updatedAt: now,
  };

  await repo.contacts.update(id, patch as never);
  const contact = { ...existing, ...patch } as Contact;
  return { contact, created: false, shouldEnrich: enrichNow };
}

/**
 * Upsert the contact AND enqueue enrichment when warranted — the one call the
 * signup/verify routes make (wrapped in their best-effort try/catch). Enrichment
 * is gated again in the worker (tenant crmConfig + region + daily cap), so this
 * never blocks or fails the signup.
 */
export async function recordSignupContact(
  ctx: TenantContext,
  campaign: Campaign,
  signup: Signup,
  db?: FirestoreLike,
): Promise<UpsertContactResult | null> {
  const res = await upsertContactFromSignup(ctx, campaign, signup, { db });
  if (res?.shouldEnrich && res.contact.companyId && res.contact.emailDomain) {
    await enqueueContactEnrich(
      ctx,
      {
        companyId: res.contact.companyId,
        domain: res.contact.emailDomain,
        campaignId: signup.campaignId,
        sampleEmail: res.contact.email,
      },
      db,
    );
  }
  return res;
}

/**
 * Reflect a signup LIFECYCLE change (offboard / delete) onto the person's CRM
 * contact, KEEPING the record. Replaces this campaign's link with the updated
 * signup's status (or removes it when `remove` is set, for a hard signup delete)
 * and recomputes the contact's top-level status across all remaining links.
 *
 * Best-effort and idempotent; returns null when the person has no contact yet
 * (e.g. created before the CRM, or phone-only with nothing to key on). Never
 * enqueues enrichment — this is a state change, not a new signup. PII erasure is
 * the separate GDPR `contact_erase` path; this only retags/segments the contact.
 */
export async function recordSignupContactStatus(
  ctx: TenantContext,
  signup: Signup,
  opts: { remove?: boolean; db?: FirestoreLike; now?: string } = {},
): Promise<Contact | null> {
  const email = signup.email ? normalizeEmail(signup.email) : null;
  const contactKey = email ?? signup.phone?.trim() ?? null;
  if (!contactKey) return null;

  const repo = forTenant(ctx, opts.db);
  const id = deterministicContactId(ctx.tenantId, contactKey);
  const existing = await repo.contacts.getById(id);
  if (!existing) return null;
  // Defence in depth: deterministic ids are globally colliding — never touch a
  // contact that isn't this tenant's (getById already re-checks, belt-and-braces).
  if (existing.tenantId !== ctx.tenantId) return null;

  const others = existing.campaigns.filter((c) => c.campaignId !== signup.campaignId);
  const campaigns = opts.remove ? others : [...others, linkFromSignup(signup)];
  const campaignIds = Array.from(new Set(campaigns.map((c) => c.campaignId)));
  const totalReferred = campaigns.reduce((s, c) => s + (c.amountReferred ?? 0), 0);
  const now = opts.now ?? new Date().toISOString();

  const patch = {
    campaigns,
    campaignIds,
    totalReferred,
    status: recomputeContactStatus(campaigns),
    updatedAt: now,
  };
  await repo.contacts.update(id, patch as never);
  return { ...existing, ...patch } as Contact;
}
