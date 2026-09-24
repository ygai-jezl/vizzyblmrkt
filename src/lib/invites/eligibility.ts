import type { ProductConnection } from "@/lib/types/productConnection";
import { environmentOf, productNameOf } from "@/lib/connect/environments";
import { isAllowedLink } from "@/lib/connect/links";
import type { InviteLockReason } from "./lockText";

/**
 * Who and where an invite can go (nav v2 phase 4). Pure and client-safe: the
 * launch header, the invites page and the send path all use the same rules.
 */

export type InviteConnection = Pick<
  ProductConnection,
  "id" | "name" | "kind" | "status" | "environment" | "signupUrl" | "linkDomains"
>;

/** A real product that's live: custom (not a sandbox), active, and not a staging connection. */
function isLiveProduct(c: InviteConnection): boolean {
  return c.kind === "custom" && c.status === "active" && environmentOf(c) !== "staging";
}

/** The sign-up link is usable: https and on one of the connection's allowed domains. */
export function hasValidSignupUrl(c: Pick<InviteConnection, "signupUrl" | "linkDomains">): boolean {
  return !!c.signupUrl && isAllowedLink(c.signupUrl, c.linkDomains ?? []);
}

/** Connections an invite can point at. */
export function inviteConnections<C extends InviteConnection>(connections: C[]): C[] {
  return connections.filter((c) => isLiveProduct(c) && hasValidSignupUrl(c));
}

export { INVITE_LOCK_TEXT, type InviteLockReason } from "./lockText";

/** The first reason inviting is locked, or null when it's open. */
export function inviteLock(input: {
  archived: boolean;
  keyConfigured: boolean;
  connections: InviteConnection[];
}): InviteLockReason | null {
  if (input.archived) return "launch_archived";
  const real = input.connections.filter((c) => c.kind === "custom" && c.status !== "revoked");
  if (real.length === 0) return "no_product";
  if (!real.some(isLiveProduct)) return "staging_only";
  if (inviteConnections(real).length === 0) return "no_signup_url";
  if (!input.keyConfigured) return "links_unconfigured";
  return null;
}

/** "Fernlight (production)" → "Fernlight": how the product is named in invite copy. */
export function inviteProductName(c: Pick<InviteConnection, "name" | "environment">): string {
  return productNameOf(c);
}
