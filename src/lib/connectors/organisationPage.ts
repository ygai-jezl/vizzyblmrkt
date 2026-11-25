import * as React from "react";
import { getAdminContextWithHome } from "@/lib/auth/session";
import { isOrganisationJoinEnabled } from "@/lib/plans/flags";
import { verifiedPersonOf } from "@/lib/tenant";
import { isConnectorsSharingEnabled } from "./flags";
import { organisationOwnerOf, type OrganisationOwner } from "./organisationOwner";

/**
 * The signed in person as an owner of their brand's organisation (Connectors 3), for the pages: the
 * Settings tabs, Settings › Organisation and a Listing's "Connect for". Null for a member, and for
 * anyone who isn't an owner and an admin of the brand they are in, all read live. Read once per
 * request (React's cache, where the build has it). Server components only.
 */
const once: <F extends (...args: never[]) => unknown>(fn: F) => F = typeof React.cache === "function" ? React.cache : (fn) => fn;

const ownerLive = once(async (): Promise<OrganisationOwner | null> => {
  const session = await getAdminContextWithHome();
  if (!session || session.ctx.role !== "admin") return null;
  const person = verifiedPersonOf(session);
  if (!person) return null;
  try {
    const r = await organisationOwnerOf(session.ctx, person);
    return r.ok ? r.owner : null;
  } catch (err) {
    console.warn("[organisation] the owner check didn't load", err instanceof Error ? err.message.slice(0, 200) : "error");
    return null;
  }
});

/** The owner while sharing is on (CONNECTORS_SHARING_ENABLED): Shared connections and "Connect for". */
export async function loadOrganisationOwner(): Promise<OrganisationOwner | null> {
  return isConnectorsSharingEnabled() ? ownerLive() : null;
}

/** Which sections Settings › Organisation shows: Shared connections with sharing on, Brands with the join on. */
export interface OrganisationSections {
  sharing: boolean;
  brands: boolean;
}

export function organisationSections(): OrganisationSections {
  return { sharing: isConnectorsSharingEnabled(), brands: isOrganisationJoinEnabled() };
}

/**
 * The owner for the Organisation tab and page, which exist while sharing or the join is on
 * (ORGANISATION_JOIN_ENABLED, Bring in and Move out): with both off, nobody has them.
 */
export async function loadOrganisationPageOwner(): Promise<OrganisationOwner | null> {
  const s = organisationSections();
  return s.sharing || s.brands ? ownerLive() : null;
}
