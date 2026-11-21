import type { Contact, ContactCampaignLink, PersonOptOuts, PersonProductLink } from "@/lib/types/contact";
import type { EmailSuppression } from "@/lib/types/emailSuppression";
import type { ProductConnection } from "@/lib/types/productConnection";
import type { ProductUser } from "@/lib/types/productUser";
import { lastActiveAt, personReach, personStage } from "./personStage";

/**
 * The person record's derived parts, worked out from its sources: a link per launch
 * sign-up, a link per product user, being added by hand, the address's opt-outs, and
 * from those the tags the People list filters on, one reach and when they were last
 * active. Pure, so the full sync, the fast path for product writes and the sweep agree.
 */

export type Reach = "yes" | "limited" | "no";

/** Tags past this many groups are dropped: a person in hundreds of workspaces is still findable by product. */
export const MAX_GROUP_TAGS = 50;

const REACH_RANK: Record<Reach, number> = { no: 0, limited: 1, yes: 2 };
const BLOCK_RANK: Record<EmailSuppression["reason"], number> = { unsubscribe: 0, spam: 1, hard_bounce: 2 };

/** The address's opt-out rows, boiled down to what reach needs. */
export function optOutsOf(rows: ReadonlyArray<Pick<EmailSuppression, "scope" | "reason" | "category">>): PersonOptOuts {
  let blocked: PersonOptOuts["blocked"] = null;
  const categories = new Set<string>();
  for (const row of rows) {
    if (row.scope === "category") {
      if (row.category) categories.add(row.category);
    } else if (!blocked || BLOCK_RANK[row.reason] > BLOCK_RANK[blocked]) {
      blocked = row.reason;
    }
  }
  return { blocked, categories: [...categories].sort() };
}

/** The same opt-outs in the shape personReach reads. */
function optOutRows(optOuts: PersonOptOuts | undefined) {
  if (!optOuts) return [];
  return [
    ...(optOuts.blocked ? [{ scope: "all" as const, reason: optOuts.blocked }] : []),
    ...optOuts.categories.map((category) => ({ scope: "category" as const, reason: "unsubscribe" as const, category })),
  ];
}

/** Whether a launch sign-up lets us email them: confirmed yes, unconfirmed only the confirmation, otherwise no. */
export function signupReach(link: Pick<ContactCampaignLink, "status">): Reach {
  if (link.status === "verified_active") return "yes";
  if (link.status === "unverified") return "limited";
  return "no";
}

/** A sign-up still counts as a source until it's deleted. */
export function isLiveSignupLink(link: Pick<ContactCampaignLink, "status">): boolean {
  return link.status !== "deleted";
}

/**
 * Whether a contact is on one of the brand's launches. With person records on, someone who
 * only uses a product has a contact too, with no sign-up: they aren't on a waitlist.
 */
export function isOnALaunch(c: { status: string; campaigns?: ReadonlyArray<Pick<ContactCampaignLink, "status">> | null }): boolean {
  return c.status !== "deleted" && (c.campaigns ?? []).some(isLiveSignupLink);
}

type LinkConnection = Pick<ProductConnection, "id" | "catalog" | "consentPolicy" | "stageClocks">;

/** One product user as the person record holds them. */
export function linkFromProductUser(
  user: ProductUser,
  connection: LinkConnection,
  optOuts: PersonOptOuts | undefined,
  nowMs: number,
): PersonProductLink {
  const stage = personStage(user, connection.catalog, nowMs, connection.stageClocks);
  const reach = personReach(user, connection.consentPolicy, optOutRows(optOuts));
  return {
    connectionId: connection.id,
    productUserId: user.id,
    stage: stage.kind,
    quiet: stage.quietDays !== null,
    activated: stage.kind === "activated",
    signedUpAt: user.signedUpAt ?? user.firstSeenAt,
    lastActiveAt: lastActiveAt(user, connection.catalog),
    reach: reach.can,
    groups: Object.keys(user.entities ?? {}).sort(),
  };
}

export interface PersonSummary {
  memberOf: string[];
  reach: Reach;
  activeAt: string | null;
  /** True while any sign-up or product user is left, or they were added by hand. */
  live: boolean;
}

/**
 * Being added by hand, as a source of its own (piece B). Keyed on the contact's `addedBy`,
 * with no switch: turning New person off never lets a sync drop anyone who was added.
 */
export interface HandAdded {
  /** When they were added: their activity, until something newer. */
  at: string;
  /** The team recorded that they agreed to marketing email, and it stands. */
  marketingConsent: boolean;
  /** They have an email address: someone added with only a phone can't be emailed, whatever they agreed. */
  hasAddress: boolean;
}

/** The hand-added source of a contact, or null when nobody added them by hand. */
export function handAddedOf(contact: Pick<Contact, "addedBy" | "consent" | "email"> | null | undefined): HandAdded | null {
  if (!contact?.addedBy) return null;
  return { at: contact.addedBy.at, marketingConsent: contact.consent?.marketing_email?.state === "granted", hasAddress: !!contact.email };
}

/** The tag every person added by hand carries. Internal: the People list has no pill for it. */
export const HAND_ADDED_TAG = "added:hand";

/**
 * Tags another writer owns, which a sync keeps exactly as they are: the field writer's `field:`
 * tags, and the hand-added mark.
 */
export function isCarriedTag(tag: string): boolean {
  return tag.startsWith("field:") || tag === HAND_ADDED_TAG;
}

/**
 * A sync's tags with the carried tags the record already has, sorted, each once. Field tags are
 * carried only while the person stays in Everyone (`summaryTags` has `all`), so a field filter
 * never shows someone Everyone doesn't; the field writer rebuilds them if they come back.
 */
export function withCarriedTags(summaryTags: readonly string[], current: readonly string[] | null | undefined): string[] {
  const live = summaryTags.includes("all");
  const carried = (current ?? []).filter((t) => isCarriedTag(t) && (live || !t.startsWith("field:")));
  return [...new Set([...summaryTags, ...carried])].sort();
}

/**
 * The tags, reach and last activity of a person, from their links. Someone added by hand is
 * live with the `all` and `added:hand` tags, active from when they were added, and can be
 * emailed only when they have an address, the team recorded their marketing consent and no
 * brand-wide opt-out stops it.
 */
export function summarize(
  campaigns: readonly ContactCampaignLink[],
  products: readonly PersonProductLink[],
  optOuts: PersonOptOuts | undefined,
  hand: HandAdded | null = null,
): PersonSummary {
  const liveCampaigns = campaigns.filter(isLiveSignupLink);
  const tags = new Set<string>();
  if (liveCampaigns.length) tags.add("launch:any");
  for (const c of liveCampaigns) {
    tags.add(`launch:${c.campaignId}`);
    tags.add(`via:${c.joinedVia ?? "form"}`);
  }
  if (products.length) tags.add("product:any");
  const groups: string[] = [];
  for (const p of products) {
    tags.add(`product:${p.connectionId}`);
    tags.add(`stage:${p.connectionId}:${p.stage}`);
    if (p.quiet) tags.add(`quiet:${p.connectionId}`);
    for (const g of p.groups) groups.push(`group:${p.connectionId}:${g}`);
  }
  for (const g of groups.slice(0, MAX_GROUP_TAGS)) tags.add(g);
  if (hand) tags.add(HAND_ADDED_TAG);
  const live = liveCampaigns.length > 0 || products.length > 0 || !!hand;
  if (live) tags.add("all");

  let reach: Reach = "no";
  if (!optOuts?.blocked) {
    const handReach: Reach[] = hand?.marketingConsent && hand.hasAddress ? ["yes"] : [];
    for (const r of [...liveCampaigns.map(signupReach), ...products.map((p) => p.reach), ...handReach]) {
      if (REACH_RANK[r] > REACH_RANK[reach]) reach = r;
    }
  }

  const times = [
    ...liveCampaigns.map((c) => c.joinedAt),
    ...products.map((p) => p.lastActiveAt ?? p.signedUpAt ?? null),
    ...(hand ? [hand.at] : []),
  ]
    .filter((t): t is string => !!t && Number.isFinite(Date.parse(t)))
    .sort();
  return { memberOf: [...tags].sort(), reach, activeAt: times.at(-1) ?? null, live };
}

/** Whether two activity times fall on the same UTC day: a change within a day isn't worth a write. */
export function sameDay(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "").slice(0, 10) === (b ?? "").slice(0, 10);
}

/** What was added to and removed from a person's tags. */
export function tagChanges(before: readonly string[], after: readonly string[]): { added: string[]; removed: string[] } {
  const was = new Set(before);
  const now = new Set(after);
  return { added: after.filter((t) => !was.has(t)), removed: before.filter((t) => !now.has(t)) };
}

/** Whether two product links differ in anything the list shows or filters on. */
export function sameProductLink(a: PersonProductLink, b: PersonProductLink): boolean {
  return (
    a.connectionId === b.connectionId &&
    a.productUserId === b.productUserId &&
    a.stage === b.stage &&
    a.quiet === b.quiet &&
    a.activated === b.activated &&
    a.reach === b.reach &&
    (a.signedUpAt ?? null) === (b.signedUpAt ?? null) &&
    sameDay(a.lastActiveAt, b.lastActiveAt) &&
    a.groups.join("\n") === b.groups.join("\n")
  );
}
