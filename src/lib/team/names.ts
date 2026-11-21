import { forTenant, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";

/**
 * Team members' names for history screens. History keeps who did something as a user id only
 * (settings versions, catalog versions, agent decisions), and the name is looked up when shown:
 * only for people who are on this brand's team now. Anyone else shows as "Former team member".
 */

/** What someone no longer on the team is called wherever history names who did something. */
export const FORMER_TEAM_MEMBER = "Former team member";

/** A team member's name from `names` (teamMemberNames), or "Former team member". */
export function memberLabel(userId: string | null | undefined, names: Readonly<Record<string, string>>): string {
  return (userId && Object.hasOwn(names, userId) ? names[userId] : undefined) || FORMER_TEAM_MEMBER;
}

/** A user as Firebase Auth knows them: what a name is made from. */
export interface TeamUser {
  uid: string;
  displayName?: string | null;
  email?: string | null;
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
  return r.users.map((u) => ({ uid: u.uid, displayName: u.displayName ?? null, email: u.email ?? null }));
}

/**
 * `{ userId: name }` for the ids given who are on this brand's team now: their display name, else
 * their sign-in address. Ids of people who left, or that Firebase Auth no longer knows, are left
 * out. Never throws: a lookup that fails leaves everyone out, so the history still shows.
 */
export async function teamMemberNames(
  ctx: TenantContext,
  userIds: ReadonlyArray<string | null | undefined>,
  opts: { db?: FirestoreLike; lookup?: UserLookup } = {},
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
    if (!onTeam.size) return {};
    const users = await (opts.lookup ?? firebaseLookup)([...onTeam]);
    const out: Record<string, string> = {};
    for (const u of users) {
      if (!onTeam.has(u.uid)) continue;
      const name = u.displayName?.trim() || u.email?.trim();
      if (name) out[u.uid] = name;
    }
    return out;
  } catch (err) {
    console.warn(`[team] names lookup failed for ${ctx.tenantId}: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
    return {};
  }
}
