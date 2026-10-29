import type { ContactCampaignLink, PersonOptOuts, PersonProductLink } from "@/lib/types/contact";
import type { EmailSuppression } from "@/lib/types/emailSuppression";
import type { ProductConnection } from "@/lib/types/productConnection";
import type { ProductUser } from "@/lib/types/productUser";
import { lastActiveAt, personReach, personStage } from "./personStage";

/**
 * The person record's derived parts, worked out from its sources: a link per launch
 * sign-up, a link per product user, the address's opt-outs, and from those the tags
 * the People list filters on, one reach and when they were last active. Pure, so the
 * full sync, the fast path for product writes and the sweep agree.
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
  /** True while any sign-up or product user is left. */
  live: boolean;
}

/** The tags, reach and last activity of a person, from their links. */
export function summarize(
  campaigns: readonly ContactCampaignLink[],
  products: readonly PersonProductLink[],
  optOuts: PersonOptOuts | undefined,
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
  const live = liveCampaigns.length > 0 || products.length > 0;
  if (live) tags.add("all");

  let reach: Reach = "no";
  if (!optOuts?.blocked) {
    for (const r of [...liveCampaigns.map(signupReach), ...products.map((p) => p.reach)]) {
      if (REACH_RANK[r] > REACH_RANK[reach]) reach = r;
    }
  }

  const times = [
    ...liveCampaigns.map((c) => c.joinedAt),
    ...products.map((p) => p.lastActiveAt ?? p.signedUpAt ?? null),
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
