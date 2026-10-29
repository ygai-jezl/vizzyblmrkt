import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { PersonProductLink } from "@/lib/types/contact";
import { getContactEmailHistory, type ContactEmailHistoryEntry } from "@/lib/crm/emailHistory";
import { inviteDocId } from "@/lib/invites/ids";
import type { InviteStage } from "@/lib/invites/inviteStage";
import { waitlistEnrolmentId, waitlistJourneyId } from "@/lib/lifecycle/waitlist/ids";
import { ENVIRONMENT_LABEL, environmentOf, productNameOf } from "@/lib/connect/environments";

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
}

function inviteStageOf(inv: { invited: boolean; signedUp: boolean; activated: boolean } | null): InviteStage | null {
  if (!inv) return null;
  return inv.activated ? "activated" : inv.signedUp ? "signed_up" : inv.invited ? "invited" : null;
}

/** Null when there's no such person in this brand. */
export async function loadWholePerson(ctx: TenantContext, personId: string, db?: FirestoreLike): Promise<WholePerson | null> {
  const repo = forTenant(ctx, db);
  const contact = await repo.contacts.getById(personId);
  if (!contact) return null;
  const links = (contact.campaigns ?? []).filter((l) => l.status !== "deleted");
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
        name: campaigns[i]?.waitlistName || "A launch",
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
      const env = c ? environmentOf(c) : null;
      return {
        connectionId: p.connectionId,
        productUserId: p.productUserId,
        stage: p.stage,
        quiet: p.quiet,
        activated: p.activated,
        signedUpAt: p.signedUpAt ?? null,
        lastActiveAt: p.lastActiveAt ?? null,
        reach: p.reach,
        name: c ? `${productNameOf(c)}${env ? ` · ${ENVIRONMENT_LABEL[env]}` : ""}` : "A product",
      };
    }),
    launchEmails,
  };
}
