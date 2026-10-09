import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { ENVIRONMENT_LABEL, environmentOf, productNameOf } from "@/lib/connect/environments";
import { onboardingSummary, type OnboardingSummary } from "@/lib/connect/onboardingSummary";
import type { EmailSuppression } from "@/lib/types/emailSuppression";
import type { ProductUser } from "@/lib/types/productUser";
import { lastActiveAt, personReach, personStage, type PersonReach, type PersonStage } from "./personStage";

/**
 * Audience → Product users with the person view on: everyone using your connected
 * products, with the stage each is at. The list is read once and searched and
 * filtered in the browser; what a row adds once it's on screen (its journey, its
 * emails) comes from loadPersonSummaries. Sandboxes are left out, as before.
 */

export interface AudiencePerson {
  id: string;
  connectionId: string;
  name: string | null;
  email: string | null;
  /** "Fernlight app · Production" */
  product: string;
  onboarding: OnboardingSummary;
  stage: PersonStage;
  /** Whether they can be emailed: their profile, and any bounce, complaint or unsubscribe in our emails. */
  reach: PersonReach;
  signedUpAt: string;
  /** The last time the product sent us anything about them. */
  lastSyncAt: string;
  /** When they last used the product, when it tells us. */
  lastActiveAt: string | null;
  onWaitlist: boolean;
  /** Came in through an invite from a launch; set only when invites are on. */
  invited?: boolean;
}

/** How many of each product's most recently updated people the list reads. */
export const PEOPLE_WINDOW = 300;

export async function loadAudiencePeople(
  ctx: TenantContext,
  deps: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<{ people: AudiencePerson[]; truncated: boolean }> {
  const repos = forTenant(ctx, deps.db);
  const nowMs = deps.nowMs ?? Date.now();
  const connections = (await repos.productConnections.find({ limit: 100 })).filter((c) => c.kind === "custom" && c.status !== "revoked");
  const perConnection = await Promise.all(
    connections.map((c) =>
      repos.productUsers
        .find({ where: [["connectionId", "==", c.id]], orderBy: [["lastSeenAt", "desc"]], limit: PEOPLE_WINDOW })
        .catch(() => [] as ProductUser[]),
    ),
  );
  const users = perConnection.flat().filter((u) => u.status === "active");
  // By address, 30 at a time (`in`, no index needed): which of them are also signups (contacts are
  // keyed by the same normalised email), and who bounced, complained or unsubscribed in our emails —
  // so "Can't email" counts everyone in the list, not only the rows whose summary has loaded.
  const keys = [...new Set(users.map((u) => u.emailNormalized).filter((k): k is string => !!k))];
  const chunks: string[][] = [];
  for (let i = 0; i < keys.length; i += 30) chunks.push(keys.slice(i, i + 30));
  const [contacts, suppressions] = await Promise.all([
    Promise.all(chunks.map((chunk) => repos.contacts.find({ where: [["contactKey", "in", chunk]] }).catch(() => []))),
    Promise.all(chunks.map((chunk) => repos.emailSuppressions.find({ where: [["normalizedEmail", "in", chunk]], limit: 2000 }))),
  ]);
  const waitlist = new Set(contacts.flat().filter((c) => c.status !== "deleted").map((c) => c.contactKey));
  const optOuts = new Map<string, EmailSuppression[]>();
  for (const o of suppressions.flat()) optOuts.set(o.normalizedEmail, [...(optOuts.get(o.normalizedEmail) ?? []), o]);
  const byId = new Map(connections.map((c) => [c.id, c]));
  const people = users
    .map((u): AudiencePerson => {
      const c = byId.get(u.connectionId)!;
      const env = environmentOf(c);
      return {
        id: u.id,
        connectionId: u.connectionId,
        name: [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || null,
        email: u.email ?? null,
        product: `${productNameOf(c)}${env ? ` · ${ENVIRONMENT_LABEL[env]}` : ""}`,
        onboarding: onboardingSummary(u, { onboardingSteps: c.catalog?.onboardingSteps ?? [], entityKinds: c.catalog?.entityKinds ?? [] }),
        stage: personStage(u, c.catalog, nowMs),
        reach: personReach(u, c.consentPolicy, (u.emailNormalized && optOuts.get(u.emailNormalized)) || []),
        signedUpAt: u.signedUpAt ?? u.firstSeenAt,
        lastSyncAt: u.lastSeenAt,
        lastActiveAt: lastActiveAt(u, c.catalog),
        onWaitlist: !!u.emailNormalized && waitlist.has(u.emailNormalized),
      };
    })
    // Newest sign-ups first: a sync moves "last seen" for everyone, so it orders nothing.
    .sort((a, b) => Date.parse(b.signedUpAt) - Date.parse(a.signedUpAt));
  return { people, truncated: perConnection.some((list) => list.length >= PEOPLE_WINDOW) };
}
