import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { AddedVia, PersonProductLink } from "@/lib/types/contact";
import { getContactEmailHistory, type ContactEmailHistoryEntry } from "@/lib/crm/emailHistory";
import { inviteDocId } from "@/lib/invites/ids";
import type { InviteStage } from "@/lib/invites/inviteStage";
import { waitlistEnrolmentId, waitlistJourneyId } from "@/lib/lifecycle/waitlist/ids";
import { ENVIRONMENT_LABEL, environmentOf, productNameOf } from "@/lib/connect/environments";
import type { FieldValues } from "@/lib/types/recordField";
import { memberLabel, teamMemberNames, type UserLookup } from "@/lib/team/names";
import { readFieldList } from "./fieldList";
import { consentWayLabel } from "./newPerson";
import { personReadOnly, type ReadOnlyValue, type VoiceChatSummary } from "./readOnlyFields";
import { isIdeaWordsEnabled } from "@/lib/ideas/flags";
import { ideaWord } from "@/lib/nav/terms";

/**
 * One person, whole (AUDIENCE_ONE_VIEW_ENABLED): their person record with each launch
 * they joined (how, where they are, their invite and their waitlist journey) and each
 * product they use, plus the emails their launches sent. The page shows each product
 * with the product user's own view.
 */

export interface WholePersonLaunch {
  campaignId: string;
  name: string;
  signupId: string;
  status: string;
  via: "form" | "site";
  joinedAt: string;
  referrals: number;
  invite: InviteStage | null;
  /** Their progress through the launch's waitlist journey, when it runs on the journey engine. */
  journey: { status: "active" | "completed" | "exited"; sent: number } | null;
}

export interface WholePersonProduct extends Pick<PersonProductLink, "connectionId" | "productUserId" | "stage" | "quiet" | "activated" | "signedUpAt" | "lastActiveAt" | "reach"> {
  name: string;
  /**
   * With field filters on (AUDIENCE_FIELD_FILTERS_ENABLED): the product's groups they belong to
   * (workspaces, teams: the product's own word as `kind`), each a filter on the People list.
   */
  groups?: Array<{ id: string; name: string | null; kind: string | null }>;
}

export interface WholePerson {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  reach: "yes" | "limited" | "no";
  blocked: "unsubscribe" | "spam" | "hard_bounce" | null;
  optedOutOf: string[];
  firstSeenAt: string;
  activeAt: string | null;
  launches: WholePersonLaunch[];
  products: WholePersonProduct[];
  /** Emails their launches sent, newest first. Each product's are on its own part of the page. */
  launchEmails: ContactEmailHistoryEntry[];
  /**
   * With fields on (AUDIENCE_FIELDS_ENABLED): their values for the brand's fields in use (archived
   * fields are left out: their values stay on the record and in the export), the fields from
   * elsewhere, and their voice chats without what was said. Null while fields are off.
   */
  fields: { values: FieldValues; readOnly: ReadOnlyValue[]; voiceChats: VoiceChatSummary[] } | null;
  /**
   * Someone on the team added them by hand (New person) or from a pasted list: who, when and from
   * where, and how they agreed to marketing email, if they did. Names are looked up now; anyone who
   * has left shows as "Former team member". Shown whatever AUDIENCE_ADD_PERSON_ENABLED says. Null
   * for everyone else.
   */
  added: {
    by: string;
    at: string;
    via: AddedVia;
    /** Where a pasted list came from, in the admin's own words (`via: "paste"`); null otherwise. */
    source: string | null;
    consent: { how: string; howLabel: string; note: string | null; by: string; at: string } | null;
    /** The team withdrew the agreement it recorded: who, when and their note. Null unless withdrawn. */
    withdrawn: { note: string | null; by: string; at: string } | null;
  } | null;
}

function inviteStageOf(inv: { invited: boolean; signedUp: boolean; activated: boolean } | null): InviteStage | null {
  if (!inv) return null;
  return inv.activated ? "activated" : inv.signedUp ? "signed_up" : inv.invited ? "invited" : null;
}

/**
 * Null when there's no such person in this brand. `fields` adds their fields (AUDIENCE_FIELDS_ENABLED),
 * `groups` each product's groups (AUDIENCE_FIELD_FILTERS_ENABLED).
 */
export async function loadWholePerson(
  ctx: TenantContext,
  personId: string,
  db?: FirestoreLike,
  opts: { fields?: boolean; groups?: boolean; lookup?: UserLookup } = {},
): Promise<WholePerson | null> {
  const repo = forTenant(ctx, db);
  const contact = await repo.contacts.getById(personId);
  if (!contact) return null;
  const links = (contact.campaigns ?? []).filter((l) => l.status !== "deleted");
  // A launch with no name (or gone), in the words in use.
  const unnamed = ideaWord(isIdeaWordsEnabled()).A;
  const [campaigns, connections, launchEmails, extras] = await Promise.all([
    Promise.all(links.map((l) => repo.campaigns.getById(l.campaignId).catch(() => null))),
    Promise.all((contact.products ?? []).map((p) => repo.productConnections.getById(p.connectionId).catch(() => null))),
    getContactEmailHistory(ctx, contact, db).catch(() => [] as ContactEmailHistoryEntry[]),
    Promise.all(
      links.map(async (l) => {
        const [invite, enrolment] = await Promise.all([
          repo.invites.getById(inviteDocId(l.campaignId, l.signupId)).catch(() => null),
          repo.waitlistEnrolments.getById(waitlistEnrolmentId(waitlistJourneyId(l.campaignId), l.signupId)).catch(() => null),
        ]);
        return { invite, enrolment };
      }),
    ),
  ]);
  const productName = (c: (typeof connections)[number] | undefined) => {
    const env = c ? environmentOf(c) : null;
    return c ? `${productNameOf(c)}${env ? ` · ${ENVIRONMENT_LABEL[env]}` : ""}` : "A product";
  };
  const users =
    opts.fields || opts.groups ? await Promise.all((contact.products ?? []).map((p) => repo.productUsers.getById(p.productUserId).catch(() => null))) : [];
  let fields: WholePerson["fields"] = null;
  if (opts.fields) {
    const [list, signups, company] = await Promise.all([
      readFieldList(ctx, "person", db),
      Promise.all(links.map((l) => repo.signups.getById(l.signupId).catch(() => null))),
      contact.companyId ? repo.companies.getById(contact.companyId).catch(() => null) : Promise.resolve(null),
    ]);
    const live = new Set(list.items.filter((f) => !f.archivedAt).map((f) => f.key));
    const named = new Map(
      connections.flatMap((c) => (c ? [[c.id, { id: c.id, catalog: c.catalog, name: productName(c) }] as const] : [])),
    );
    const extra = personReadOnly({
      signups: links.flatMap((l, i) => (signups[i] ? [{ signup: signups[i]!, launchName: campaigns[i]?.waitlistName || unnamed }] : [])),
      products: contact.products ?? [],
      users: users.filter((u): u is NonNullable<typeof u> => !!u && u.status === "active"),
      connections: named,
      company,
    });
    fields = {
      values: Object.fromEntries(Object.entries(contact.fields ?? {}).filter(([id]) => live.has(id))),
      readOnly: extra.values,
      voiceChats: extra.voiceChats,
    };
  }
  let added: WholePerson["added"] = null;
  if (contact.addedBy) {
    const consent = contact.consent?.marketing_email?.state === "granted" ? contact.consent.marketing_email : null;
    const withdrawn = contact.consent?.marketing_email?.state === "withdrawn" ? contact.consent.marketing_email : null;
    const names = await teamMemberNames(ctx, [contact.addedBy.kind === "member" ? contact.addedBy.id : null, consent?.recordedBy, withdrawn?.recordedBy], { db, lookup: opts.lookup });
    added = {
      by: contact.addedBy.kind === "agent" ? "Vizzy, confirmed by your team" : memberLabel(contact.addedBy.id, names),
      at: contact.addedBy.at,
      via: contact.addedBy.via,
      source: contact.addedBy.source ?? null,
      consent: consent ? { how: consent.how, howLabel: consentWayLabel(consent.how), note: consent.note, by: memberLabel(consent.recordedBy, names), at: consent.at } : null,
      withdrawn: withdrawn ? { note: withdrawn.note, by: memberLabel(withdrawn.recordedBy, names), at: withdrawn.at } : null,
    };
  }
  return {
    id: contact.id,
    name: [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim() || null,
    email: contact.email ?? null,
    phone: contact.phone ?? null,
    reach: contact.reach ?? "no",
    blocked: contact.optOuts?.blocked ?? null,
    optedOutOf: contact.optOuts?.categories ?? [],
    firstSeenAt: contact.firstSeenAt,
    activeAt: contact.activeAt ?? null,
    launches: links.map((l, i) => {
      const { invite, enrolment } = extras[i]!;
      return {
        campaignId: l.campaignId,
        name: campaigns[i]?.waitlistName || unnamed,
        signupId: l.signupId,
        status: l.status,
        via: l.joinedVia ?? "form",
        joinedAt: l.joinedAt,
        referrals: l.amountReferred ?? 0,
        invite: inviteStageOf(invite),
        journey: enrolment ? { status: enrolment.status, sent: enrolment.sentItems?.length ?? 0 } : null,
      };
    }),
    products: (contact.products ?? []).map((p, i) => {
      const c = connections[i];
      const entities = users[i]?.entities ?? {};
      const kinds = new Map((c?.catalog?.entityKinds ?? []).map((k) => [k.kind, k.label]));
      return {
        connectionId: p.connectionId,
        productUserId: p.productUserId,
        stage: p.stage,
        quiet: p.quiet,
        activated: p.activated,
        signedUpAt: p.signedUpAt ?? null,
        lastActiveAt: p.lastActiveAt ?? null,
        reach: p.reach,
        name: productName(c),
        ...(opts.groups
          ? {
              groups: (p.groups ?? []).map((id) => {
                const e = entities[id];
                return { id, name: e?.name ?? null, kind: e ? (kinds.get(e.kind) ?? e.kind) : null };
              }),
            }
          : {}),
      };
    }),
    launchEmails,
    fields,
    added,
  };
}
