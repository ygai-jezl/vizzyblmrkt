import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { ENVIRONMENT_LABEL, environmentOf, productNameOf } from "@/lib/connect/environments";
import type { ProductConnection } from "@/lib/types/productConnection";
import type { ProductUser } from "@/lib/types/productUser";

/**
 * Audience → Product users (nav v2 phase 3): the people using your connected
 * products, in the same place as your waitlist signups. A product user and a
 * signup with the same address are the same person — flagged "On your waitlist" —
 * but they stay separate records (each product's users belong to that product).
 * Sandboxes are left out: their users are test people.
 */

export interface AudienceProductUser {
  id: string;
  connectionId: string;
  name: string | null;
  email: string | null;
  /** "Fernlight app · Production" */
  product: string;
  stepsDone: number;
  stepsTotal: number;
  lastSeenAt: string;
  onWaitlist: boolean;
  /** Came in through an invite from a launch (nav v2 phase 4); set only when invites are on. */
  invited?: boolean;
}

/** How many of the most recently seen users the tab lists (per product page has everyone). */
export const AUDIENCE_PRODUCT_USERS_LIMIT = 100;

export function audienceProductRows(
  connections: Array<Pick<ProductConnection, "id" | "name" | "environment" | "catalog">>,
  users: Array<Pick<ProductUser, "id" | "connectionId" | "firstName" | "lastName" | "email" | "emailNormalized" | "steps" | "lastSeenAt" | "status">>,
  waitlistKeys: Set<string>,
): AudienceProductUser[] {
  const byId = new Map(connections.map((c) => [c.id, c]));
  return users
    .filter((u) => u.status !== "deleted" && byId.has(u.connectionId))
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
    .slice(0, AUDIENCE_PRODUCT_USERS_LIMIT)
    .map((u) => {
      const c = byId.get(u.connectionId)!;
      const env = environmentOf(c);
      const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
      return {
        id: u.id,
        connectionId: u.connectionId,
        name: name || null,
        email: u.email ?? null,
        product: `${productNameOf(c)}${env ? ` · ${ENVIRONMENT_LABEL[env]}` : ""}`,
        stepsDone: Object.keys(u.steps ?? {}).length,
        stepsTotal: c.catalog?.onboardingSteps?.length ?? 0,
        lastSeenAt: u.lastSeenAt,
        onWaitlist: !!u.emailNormalized && waitlistKeys.has(u.emailNormalized),
      };
    });
}

export async function loadAudienceProductUsers(ctx: TenantContext, db?: FirestoreLike): Promise<AudienceProductUser[]> {
  const repos = forTenant(ctx, db);
  const connections = (await repos.productConnections.find({ limit: 100 })).filter(
    (c) => c.kind === "custom" && c.status !== "revoked",
  );
  const perConnection = await Promise.all(
    connections.map((c) =>
      repos.productUsers
        .find({
          where: [["connectionId", "==", c.id]],
          orderBy: [["lastSeenAt", "desc"]],
          limit: AUDIENCE_PRODUCT_USERS_LIMIT,
        })
        .catch(() => [] as ProductUser[]),
    ),
  );
  const users = perConnection.flat();
  // Which of them are also signups: contacts are keyed by the same normalised email.
  const keys = [...new Set(users.map((u) => u.emailNormalized).filter((k): k is string => !!k))];
  const waitlist = new Set<string>();
  for (let i = 0; i < keys.length; i += 30) {
    const found = await repos.contacts.find({ where: [["contactKey", "in", keys.slice(i, i + 30)]] }).catch(() => []);
    for (const c of found) if (c.status !== "deleted") waitlist.add(c.contactKey);
  }
  return audienceProductRows(connections, users, waitlist);
}
