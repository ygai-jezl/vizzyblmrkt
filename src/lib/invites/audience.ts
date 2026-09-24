import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { Invite } from "@/lib/types/invite";
import type { InviteStage } from "./inviteStage";

/**
 * Invite stages for the people on an Audience page (nav v2 phase 4): the most
 * advanced of Invited → Signed up → Activated across their launches. Looked up
 * 30 at a time with `in` (no index needed), only for the rows on screen.
 */

export { INVITE_STAGE_LABEL, type InviteStage } from "./inviteStage";

const RANK: Record<InviteStage, number> = { invited: 1, signed_up: 2, activated: 3 };

function stageOf(i: Pick<Invite, "invited" | "signedUp" | "activated">): InviteStage | null {
  if (i.activated) return "activated";
  if (i.signedUp) return "signed_up";
  if (i.invited) return "invited";
  return null;
}

function better(a: InviteStage | null | undefined, b: InviteStage | null): InviteStage | null {
  if (!a) return b;
  if (!b) return a;
  return RANK[b] > RANK[a] ? b : a;
}

async function findIn(ctx: TenantContext, field: "signupId" | "productUserId", ids: string[], db?: FirestoreLike) {
  const repo = forTenant(ctx, db).invites;
  const unique = [...new Set(ids.filter(Boolean))];
  const out: Invite[] = [];
  for (let i = 0; i < unique.length; i += 30) {
    out.push(...(await repo.find({ where: [[field, "in", unique.slice(i, i + 30)]] })));
  }
  return out;
}

/** Contacts with their furthest invite stage across all their launches. */
export async function withInviteStages<T extends { campaigns?: Array<{ signupId: string }> }>(
  ctx: TenantContext,
  contacts: T[],
  db?: FirestoreLike,
): Promise<Array<T & { invite: InviteStage | null }>> {
  const invites = await findIn(ctx, "signupId", contacts.flatMap((c) => (c.campaigns ?? []).map((l) => l.signupId)), db);
  const bySignup = new Map<string, InviteStage | null>();
  for (const inv of invites) bySignup.set(inv.signupId, better(bySignup.get(inv.signupId), stageOf(inv)));
  return contacts.map((c) => ({
    ...c,
    invite: (c.campaigns ?? []).reduce<InviteStage | null>((best, l) => better(best, bySignup.get(l.signupId) ?? null), null),
  }));
}

/** Which of these product users came in through an invite. */
export async function invitedProductUsers(ctx: TenantContext, productUserIds: string[], db?: FirestoreLike): Promise<Set<string>> {
  const invites = await findIn(ctx, "productUserId", productUserIds, db);
  return new Set(invites.map((i) => i.productUserId).filter((id): id is string => !!id));
}
