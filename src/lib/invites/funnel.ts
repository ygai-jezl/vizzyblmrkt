import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { WhereClause } from "@/lib/tenant/repository";

/**
 * The growth path in numbers (nav v2 phase 4): Waitlisted → Verified → Invited →
 * Signed up → Activated, for one launch or the whole brand. Every count is an
 * equality-only `count()`, so no composite index is needed. The invite stages
 * come from the invite flags, which only ever move forward.
 */

export interface Funnel {
  waitlisted: number;
  verified: number;
  invited: number;
  signedUp: number;
  activated: number;
}

export const FUNNEL_STAGES: Array<{ key: keyof Funnel; label: string }> = [
  { key: "waitlisted", label: "Waitlisted" },
  { key: "verified", label: "Verified" },
  { key: "invited", label: "Invited" },
  { key: "signedUp", label: "Signed up" },
  { key: "activated", label: "Activated" },
];

export async function loadFunnel(
  ctx: TenantContext,
  scope: { campaignId?: string | null; waveId?: string | null } = {},
  db?: FirestoreLike,
): Promise<Funnel> {
  const repos = forTenant(ctx, db);
  const launch: WhereClause[] = scope.campaignId ? [["campaignId", "==", scope.campaignId]] : [];
  const invites: WhereClause[] = [...launch, ...(scope.waveId ? ([["waveId", "==", scope.waveId]] as WhereClause[]) : [])];
  const [all, deleted, verified, verifiedDeleted, invited, signedUp, activated] = await Promise.all([
    repos.signups.count(launch),
    repos.signups.count([...launch, ["status", "==", "deleted"]]),
    repos.signups.count([...launch, ["verified", "==", true]]),
    repos.signups.count([...launch, ["verified", "==", true], ["status", "==", "deleted"]]),
    repos.invites.count([...invites, ["invited", "==", true]]),
    repos.invites.count([...invites, ["signedUp", "==", true]]),
    repos.invites.count([...invites, ["activated", "==", true]]),
  ]);
  return {
    waitlisted: Math.max(0, all - deleted),
    verified: Math.max(0, verified - verifiedDeleted),
    invited,
    signedUp,
    activated,
  };
}

/** "300 invited · 212 signed up" — the launch checklist's line. */
export function inviteProgressLine(f: Pick<Funnel, "invited" | "signedUp">): string {
  return `${f.invited.toLocaleString("en-GB")} invited · ${f.signedUp.toLocaleString("en-GB")} signed up`;
}
