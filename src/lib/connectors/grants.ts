import type { TenantContext } from "@/lib/tenant";
import type { TenantRole } from "@/lib/types/tenantUser";
import { GRANT_TARGETS, type ConnectionGrant, type GrantTarget } from "@/lib/types/dataConnection";

/**
 * Who may do what with a connection (ADR-0011). Roles come from the brand membership
 * (admin | member). The table, cell by cell, is tested in grants.test.ts:
 *
 * - Admins always see, read live and manage every connection. That can't be removed.
 * - Members see each connection's name and health. They read its numbers live only with the
 *   grant {to: "members", can: "read"}, and every manage action is refused.
 * - Vizzy gets nothing unless the grant {to: "agent:vizzy", can: "read"} is set, and never
 *   manages. Reading for a member also needs the members grant, so asking Vizzy never shows a
 *   member more than they could read themselves.
 * - Only admins change grants. A new connection starts with none.
 * - "manage" is never a grant: it is the admin role. The admin who connected (ownerUid) gets
 *   nothing extra, and the connection stays when they leave.
 */

export const MANAGE_ACTIONS = ["connect", "check", "pause", "resume", "change_grants", "disconnect"] as const;
export type ManageAction = (typeof MANAGE_ACTIONS)[number];
/** see: name and health; see_details: account, owner, grants and recent activity. */
export type ConnectorAction = "see" | "see_details" | "read_live" | ManageAction;
export const CONNECTOR_ACTIONS: readonly ConnectorAction[] = ["see", "see_details", "read_live", ...MANAGE_ACTIONS];

export type ConnectorActor =
  | { kind: "human"; uid: string; role: TenantRole | undefined }
  /** Vizzy, reading for the signed-in person whose role its canvas token carries. */
  | { kind: "agent"; agent: "vizzy"; forRole: TenantRole | undefined }
  /**
   * One of the brand's own scheduled jobs (an article refresh review, BLOG_REFRESH_ENABLED; Next up
   * reading a kind of data through readByUse, ADR-0019; How it went's monthly look). What it reads is kept for the whole team
   * and Vizzy to see, so it may read only a connection that already feeds planning (members and
   * Vizzy may both read it), and only live.
   */
  | { kind: "job"; job: ConnectorJob };

/** The brand's scheduled jobs that read connections (strategy_month: How it went, STRATEGY_RESULTS_ENABLED). */
export type ConnectorJob = "article_review" | "next_up" | "strategy_month";

/** The person acting in an admin route. A context with no role is treated as a member. */
export function humanActor(ctx: TenantContext): ConnectorActor {
  return { kind: "human", uid: ctx.userId ?? "", role: ctx.role };
}

function has(grants: readonly ConnectionGrant[], to: GrantTarget): boolean {
  return grants.some((g) => g.to === to && g.can === "read");
}

/** Whether the actor may do this to a connection with these grants. */
export function can(actor: ConnectorActor, action: ConnectorAction, grants: readonly ConnectionGrant[] = []): boolean {
  if (actor.kind === "job") return (action === "see" || action === "read_live") && feedsPlanning(grants);
  if (actor.kind === "agent") {
    if (action !== "see" && action !== "read_live") return false;
    if (!has(grants, "agent:vizzy")) return false;
    return action === "see" || actor.forRole === "admin" || has(grants, "members");
  }
  if (actor.role === "admin") return true;
  if (action === "see") return true;
  if (action === "read_live") return has(grants, "members");
  return false;
}

/**
 * Whether a connection feeds planning (Connectors 2 group 4, ADR-0012): suggestions from its
 * numbers, Next up lines and context pack lines. Only when both members and Vizzy may read it, as
 * those are stored once per brand and seen by the whole team and by Vizzy, so none can follow one
 * viewer's access. No third grant.
 */
export function feedsPlanning(grants: readonly ConnectionGrant[] = []): boolean {
  return has(grants, "members") && has(grants, "agent:vizzy");
}

/** The grants to store: known targets only, each once, in a fixed order. */
export function normaliseGrants(list: readonly ConnectionGrant[]): ConnectionGrant[] {
  return GRANT_TARGETS.filter((to) => list.some((g) => g.to === to && g.can === "read")).map((to) => ({ to, can: "read" as const }));
}

/** A short code for an activity row: which targets may read, e.g. "members,agent:vizzy" or "none". */
export function grantsCode(list: readonly ConnectionGrant[]): string {
  const g = normaliseGrants(list);
  return g.length ? g.map((x) => x.to).join(",") : "none";
}
