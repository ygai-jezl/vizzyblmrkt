import { forTenant, writeRecordWithEvents, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { Contact, ContactAddedBy, ContactConsentEntry } from "@/lib/types/contact";
import type { EventWrite } from "@/lib/types/ontologyEvent";
import { checkFieldValue } from "@/lib/types/recordField";
import { normalizeEmail } from "@/lib/waitlist/identifiers";
import { isPublicEmailProvider } from "@/lib/domains/registrableDomain";
import { deterministicCompanyId, domainFromEmail } from "@/lib/crm/identifiers";
import { buildSearchTokens } from "@/lib/crm/searchTokens";
import { actorOf } from "@/lib/ontology/events";
import { consentRecordedEvent, recordCreatedEvent } from "@/lib/ontology/eventBuilders";
import { isContactPersonId, type ContactPersonId } from "@/lib/ontology/person";
import { checkAllowance, type UsageDeps } from "@/lib/plans/usage";
import { readFieldList } from "./fieldList";
import { setFieldValues } from "./fields";
import { handAddedOf, optOutsOf, summarize, withCarriedTags } from "./personLinks";
import { optOutRowsFor, personIdOf, sortKeyOf, syncPersonSafe } from "./personSync";
import { EMAIL_RE, type ConsentWay, type NewPerson, type NewPersonInfo } from "./newPerson";

/**
 * Adding someone by hand (AUDIENCE_ADD_PERSON_ENABLED; the routes check the switch). The person is
 * keyed as a sign-up would be: their normalised address, or their phone trimmed and nothing more,
 * so a later sign-up with the same address or phone joins them. A key already held opens that
 * person and writes nothing.
 *
 * The contact, its record.created event and, when they agreed, its consent.recorded event commit
 * in one transaction (writeRecordWithEvents). The record is built from the hand-added summary
 * (group 3): live, tagged `all` and `added:hand`, and can be emailed only with recorded consent
 * and no brand-wide opt-out. Field values follow through the one writer once they are added.
 * Nothing sends to people added by hand yet: no journey or broadcast reads them until lists
 * (piece E) or consent (piece F) do.
 */

export type AddPersonResult =
  | {
      outcome: "created";
      personId: ContactPersonId;
      /** Field values: none were given, they saved, or they didn't (the person is added either way). */
      fields: "none" | "saved" | "not_saved";
    }
  | { outcome: "existing"; personId: ContactPersonId }
  | { outcome: "rejected"; error: "unknown_field" | "archived_field" | "invalid_value" | "no_user"; fieldId?: string };

/** The person key the form's details give: the address, else the trimmed phone. */
export function newPersonKey(p: Pick<NewPerson, "email" | "phone">): string | null {
  return (p.email ? normalizeEmail(p.email) : null) || p.phone?.trim() || null;
}

/** The consent entry kept on the record: the current state. Its consent.recorded event is the proof. */
export function consentEntry(agreed: { how: ConsentWay; note: string | null }, recordedBy: string, at: string): ContactConsentEntry {
  return { state: "granted", how: agreed.how, note: agreed.note, recordedBy, at, agreedAt: null };
}

/** Field values checked against the People list as it is now, before anything is written. */
async function checkFields(ctx: TenantContext, values: Record<string, unknown>, db?: FirestoreLike) {
  const entries = Object.entries(values);
  if (!entries.length) return null;
  const list = await readFieldList(ctx, "person", db);
  const byId = new Map(list.items.map((f) => [f.key, f]));
  for (const [fieldId, raw] of entries) {
    const field = byId.get(fieldId);
    if (!field) return { error: "unknown_field" as const, fieldId };
    if (field.archivedAt) return { error: "archived_field" as const, fieldId };
    if (!checkFieldValue(field, raw).ok) return { error: "invalid_value" as const, fieldId };
  }
  return null;
}

/**
 * Add someone by hand, or find who already holds their address or phone. `fields` are set only
 * when the caller passes them (the route passes them while AUDIENCE_FIELDS_ENABLED is on).
 */
export async function addPerson(
  ctx: TenantContext,
  input: NewPerson,
  deps: { db?: FirestoreLike; nowIso?: string; fields?: boolean } = {},
): Promise<AddPersonResult> {
  const key = newPersonKey(input);
  const userId = ctx.userId;
  if (!key) throw new Error("addPerson needs an email or a phone");
  if (!userId || userId.includes("@")) return { outcome: "rejected", error: "no_user" };
  const personId = personIdOf(ctx.tenantId, key);
  if (!isContactPersonId(personId)) throw new Error("not a person id");
  const fieldValues = deps.fields ? input.fields : {};
  const bad = await checkFields(ctx, fieldValues, deps.db);
  if (bad) return { outcome: "rejected", ...bad };

  const nowIso = deps.nowIso ?? new Date().toISOString();
  const actor = actorOf(ctx);
  const email = input.email ? normalizeEmail(input.email) : null;
  const phone = input.phone?.trim() || null;
  const emailDomain = email ? domainFromEmail(email) : null;
  const isCorporate = !!email && !!emailDomain && !isPublicEmailProvider(email);
  const companyId = isCorporate && emailDomain ? deterministicCompanyId(ctx.tenantId, emailDomain) : null;
  const addedBy: ContactAddedBy = { kind: "member", id: userId, at: nowIso, via: input.via };
  const consent = input.agreed ? { marketing_email: consentEntry(input.agreed, userId, nowIso) } : undefined;
  // Read before the transaction: an address that unsubscribed keeps them unreachable from the start.
  const optOuts = optOutsOf(await optOutRowsFor(ctx, key, deps.db));
  const summary = summarize([], [], optOuts, handAddedOf({ addedBy, consent, email }));

  const create: Omit<Contact, "id" | "tenantId"> = {
    contactKey: key,
    email,
    phone,
    firstName: input.firstName,
    lastName: input.lastName,
    status: "active",
    verified: false,
    consentStatus: "none",
    emailDomain,
    isCorporateDomain: isCorporate,
    companyId,
    campaigns: [],
    campaignIds: [],
    totalReferred: 0,
    // Never enriched: enrichment needs a confirmed sign-up.
    enrichment: { status: email && !isCorporate ? "skipped" : "none", companyId, domain: emailDomain },
    searchTokens: buildSearchTokens([input.firstName, input.lastName, email, emailDomain, email ? null : phone]),
    retentionUntil: null,
    addedBy,
    ...(consent ? { consent } : {}),
    products: [],
    memberOf: withCarriedTags(summary.memberOf, []),
    reach: summary.reach,
    optOuts,
    activeAt: nowIso,
    sortKey: sortKeyOf(nowIso, personId),
    changedAt: nowIso,
    needsSync: false,
    firstSeenAt: nowIso,
    updatedAt: nowIso,
    createdAt: nowIso,
  };
  const events: EventWrite[] = [
    recordCreatedEvent({ subject: { type: "person", id: personId }, personId, via: input.via, actor, at: nowIso }),
    ...(input.agreed
      ? [
          consentRecordedEvent({
            personId,
            purpose: "marketing_email",
            how: input.agreed.how,
            note: input.agreed.note,
            recordedBy: userId,
            agreedAt: null,
            at: nowIso,
            actor,
          }),
        ]
      : []),
  ];

  const written = await writeRecordWithEvents(ctx, "contacts", personId, (current) => (current ? { reject: "exists" } : { create, events }), {
    db: deps.db,
    nowIso,
  });
  if (written.outcome === "rejected" && written.reason === "exists") return { outcome: "existing", personId };
  if (written.outcome !== "created") throw new Error(`add person: ${written.outcome === "rejected" ? written.reason : written.outcome}`);

  // Any sign-up or product user already holding the key (one no sync has reached yet) joins them.
  await syncPersonSafe(ctx, key, { db: deps.db, nowMs: Date.parse(nowIso) });

  if (!Object.keys(fieldValues).length) return { outcome: "created", personId, fields: "none" };
  const set = await setFieldValues(ctx, { object: "person", recordId: personId, changes: fieldValues, by: actor, source: "editor" }, { db: deps.db }).catch(() => null);
  return { outcome: "created", personId, fields: set?.ok ? "saved" : "not_saved" };
}

export type RecordConsentResult =
  | { outcome: "recorded" | "unchanged"; consent: ContactConsentEntry }
  | { outcome: "rejected"; error: "not_found" | "consent_elsewhere" | "no_user" };

/**
 * Record that someone added by hand agreed to marketing email, after they were added: the entry,
 * their reach and a consent.recorded event in one transaction. Anyone else's consent comes from
 * their launch or product (piece F decides more). Recorded already: nothing is written.
 */
export async function recordHandConsent(
  ctx: TenantContext,
  personId: string,
  agreed: { how: ConsentWay; note: string | null },
  deps: { db?: FirestoreLike; nowIso?: string } = {},
): Promise<RecordConsentResult> {
  const userId = ctx.userId;
  if (!userId || userId.includes("@")) return { outcome: "rejected", error: "no_user" };
  if (!isContactPersonId(personId)) return { outcome: "rejected", error: "not_found" };
  const nowIso = deps.nowIso ?? new Date().toISOString();
  const actor = actorOf(ctx);
  const seen: { entry: ContactConsentEntry | null } = { entry: null };
  const written = await writeRecordWithEvents(
    ctx,
    "contacts",
    personId,
    (current) => {
      if (!current) return { reject: "not_found" };
      if (!current.addedBy) return { reject: "consent_elsewhere" };
      const was = current.consent?.marketing_email;
      if (was?.state === "granted") {
        seen.entry = was;
        return null;
      }
      const entry = consentEntry(agreed, userId, nowIso);
      const next = { ...current, consent: { ...(current.consent ?? {}), marketing_email: entry } };
      const summary = summarize(current.campaigns ?? [], current.products ?? [], current.optOuts, handAddedOf(next));
      const reachChanged = summary.reach !== current.reach;
      return {
        patch: { consent: next.consent, reach: summary.reach, ...(reachChanged ? { changedAt: nowIso } : {}), updatedAt: nowIso },
        events: [consentRecordedEvent({ personId, purpose: "marketing_email", how: agreed.how, note: agreed.note, recordedBy: userId, agreedAt: null, at: nowIso, actor })],
      };
    },
    { db: deps.db, nowIso },
  );
  if (written.outcome === "rejected") return { outcome: "rejected", error: written.reason as "not_found" | "consent_elsewhere" };
  if (written.outcome === "unchanged" && seen.entry) return { outcome: "unchanged", consent: seen.entry };
  if (written.outcome !== "created" && written.outcome !== "updated") throw new Error("record consent: nothing written");
  return { outcome: "recorded", consent: written.doc.consent!.marketing_email! };
}

/** The allowance through piece A's checkAllowance (which never locks), and the company for `email`. */
export async function newPersonInfo(ctx: TenantContext, email: string | null, deps: { db?: FirestoreLike; usage?: UsageDeps } = {}): Promise<NewPersonInfo> {
  const address = email && EMAIL_RE.test(email.trim()) ? normalizeEmail(email) : null;
  const domain = address ? domainFromEmail(address) : null;
  const corporate = !!address && !!domain && !isPublicEmailProvider(address);
  const [use, company] = await Promise.all([
    checkAllowance(ctx, "people", 1, deps.usage).catch(() => null),
    corporate && domain ? forTenant(ctx, deps.db).companies.getById(deterministicCompanyId(ctx.tenantId, domain)).catch(() => null) : Promise.resolve(null),
  ]);
  return {
    allowance: use && use.used !== null && use.limit !== null ? { used: use.used, limit: use.limit } : null,
    company: corporate && domain ? { name: company?.name ?? null, domain } : null,
  };
}
