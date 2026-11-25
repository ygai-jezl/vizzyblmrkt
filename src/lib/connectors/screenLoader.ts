import { cache } from "react";
import { requireAdminContext } from "@/lib/auth/session";
import { loadOrganisationOwner } from "./organisationPage";
import { connectionsScreenFor, type ConnectionsScreen } from "./screens";

/**
 * The Settings › Connections screen data for the signed in person, read once per request: the
 * layout's Connected count and the page share it, with whether collected numbers are on (the
 * Collected column, and the connection a Review row links to by `?c=<id>`), and whether they own
 * this brand's organisation (the same live check as the Organisation tab, so a part that needs its
 * organisation offers Fix exactly when that tab shows). Server components only (React's cache).
 */
export const loadConnectionsScreen = cache(async (): Promise<ConnectionsScreen> => {
  const ctx = await requireAdminContext();
  const owner = await loadOrganisationOwner();
  return connectionsScreenFor(ctx, {}, { owner: owner !== null && owner.ctx.tenantId === ctx.tenantId });
});
