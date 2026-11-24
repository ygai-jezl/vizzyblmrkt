import * as React from "react";
import { getAdminContextWithHome } from "@/lib/auth/session";
import { verifiedPersonOf } from "@/lib/tenant";
import { isConnectorsSharingEnabled } from "./flags";
import { organisationOwnerOf, type OrganisationOwner } from "./organisationOwner";

/**
 * The signed in person as an owner of their brand's organisation (Connectors 3), for the pages: the
 * Settings tabs, Settings › Organisation and a Listing's "Connect for". Null while sharing is off,
 * for a member, and for anyone who isn't an owner and an admin of the brand they are in, all read
 * live. Read once per request (React's cache, where the build has it). Server components only.
 */
const once: <F extends (...args: never[]) => unknown>(fn: F) => F = typeof React.cache === "function" ? React.cache : (fn) => fn;

export const loadOrganisationOwner = once(async (): Promise<OrganisationOwner | null> => {
  if (!isConnectorsSharingEnabled()) return null;
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
