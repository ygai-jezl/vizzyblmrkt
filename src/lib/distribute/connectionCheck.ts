import type { Tenant } from "@/lib/types/tenant";
import type { ScheduledPostChannel } from "@/lib/types/scheduledPost";

/** Why a post couldn't go out for want of a connected account: the same codes the worker parks with. */
export type ConnectionProblem = "x_not_connected" | "linkedin_not_connected" | "linkedin_page_not_connected";

/**
 * The order guard for Distribute: would this post find an account to publish
 * from? It reads the connections the way the worker picks an author
 * (scheduler.ts), without refreshing tokens: an expired token can still be
 * refreshed at publish time. Channels YouGrow doesn't post itself need nothing.
 */
export function connectionProblem(
  tenant: Pick<Tenant, "socialConnections"> | null,
  channel: ScheduledPostChannel,
  linkedInAuthorUrn?: string | null,
): ConnectionProblem | null {
  const social = tenant?.socialConnections;
  if (channel === "x") return social?.x ? null : "x_not_connected";
  if (channel !== "linkedin") return null;
  const orgs = social?.linkedin_org?.orgs ?? [];
  if (linkedInAuthorUrn?.startsWith("urn:li:organization:")) {
    return orgs.some((o) => o.urn === linkedInAuthorUrn) ? null : "linkedin_page_not_connected";
  }
  // No choice made: the connected member, else the first Page the brand administers.
  return social?.linkedin?.userId || orgs.length > 0 ? null : "linkedin_not_connected";
}
