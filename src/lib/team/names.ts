import { forTenant, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { A_TEAM_MEMBER, FORMER_TEAM_MEMBER } from "./former";

/**
 * Team members' names for history screens. History keeps who did something as a user id only
 * (settings versions, catalog versions, agent decisions), and the name is looked up when shown:
 * only for people who are on this brand's team now, by a `tenant_users` row or because their
 * verified sign-in claims put them on this brand (the brand they first signed in with, which gives
 * them no row). Anyone else shows as "Former team member".
 */

/** What someone no longer on the team is called wherever history names who did something. */
export { A_TEAM_MEMBER, FORMER_TEAM_MEMBER };

/** A team member's name from `names` (teamMemberNames), or "Former team member". */
export function memberLabel(userId: string | null | undefined, names: Readonly<Record<string, string>>): string {
  return (userId && Object.hasOwn(names, userId) ? names[userId] : undefined) || FORMER_TEAM_MEMBER;
}

/** A user as Firebase Auth knows them: what a name is made from. */
export interface TeamUser {
  uid: string;
  displayName?: string | null;
  email?: string | null;
  /** The brand their verified sign-in claims put them on (the brand they first signed in with), if any. */
  tenantId?: string | null;
}

/** Looks users up by id. The default asks Firebase Auth; tests pass their own. */
export type UserLookup = (uids: string[]) => Promise<TeamUser[]>;

/** Ids in one membership query (Firestore's `in` limit). */
const IN_CHUNK = 30;
/** Ids looked up at once (Firebase Auth's getUsers limit), and the most one screen asks about. */
const MAX_IDS = 100;

async function firebaseLookup(uids: string[]): Promise<TeamUser[]> {
  const { adminAuth } = await import("@/lib/auth/adminAuth");
  const r = await adminAuth().getUsers(uids.map((uid) => ({ uid })));
  return r.users.map((u) => {
    const claimed = (u.customClaims as { tenant_id?: unknown } | undefined)?.tenant_id;
    return { uid: u.uid, displayName: u.displayName ?? null, email: u.email ?? null, tenantId: typeof claimed === "string" ? claimed : null };
  });
}

/**
 * `{ userId: name }` for the ids given who are on this brand's team now: a `tenant_users` row for
 * it, or verified claims that put them on it. Their display name, else their sign-in address, or
 * "A team member" with `addresses: false` (what Vizzy is told, which never carries an address).
 * Ids of people who left, or that Firebase Auth no longer knows, are left out. Never throws: a
 * lookup that fails leaves everyone out, so the history still shows.
 */
export async function teamMemberNames(
  ctx: TenantContext,
  userIds: ReadonlyArray<string | null | undefined>,
  opts: { db?: FirestoreLike; lookup?: UserLookup; addresses?: boolean } = {},
): Promise<Record<string, string>> {
  const ids = [...new Set(userIds.filter((id): id is string => typeof id === "string" && id !== "" && !id.includes("@")))].slice(0, MAX_IDS);
  if (!ids.length) return {};
  try {
    const members = forTenant(ctx, opts.db).members;
    const onTeam = new Set<string>();
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const rows = await members.find({ where: [["userId", "in", ids.slice(i, i + IN_CHUNK)]] });
      for (const r of rows) onTeam.add(r.userId);
    }
    // Everyone asked about is looked up: someone with no row may be on the team by their claims.
    const users = await (opts.lookup ?? firebaseLookup)(ids);
    const asked = new Set(ids);
    const out: Record<string, string> = {};
    for (const u of users) {
      if (!asked.has(u.uid) || !(onTeam.has(u.uid) || u.tenantId === ctx.tenantId)) continue;
      const name = u.displayName?.trim() || (opts.addresses === false ? A_TEAM_MEMBER : u.email?.trim());
      if (name) out[u.uid] = name;
    }
    return out;
  } catch (err) {
    console.warn(`[team] names lookup failed for ${ctx.tenantId}: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
    return {};
  }
}
