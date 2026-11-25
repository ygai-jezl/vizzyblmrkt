import { notFound, redirect } from "next/navigation";
import { ListingView } from "@/components/admin/connectors/ListingView";
import { ScreenUnavailable } from "@/components/admin/connectors/Notices";
import { listingBanner } from "@/components/admin/connectors/listingBanner";
import { pickPath, replaceableOf } from "@/components/admin/connectors/words";
import { isConnectorsScreenEnabled } from "@/lib/connectors/flags";
import { organisationListing } from "@/lib/connectors/organisationConnect";
import { loadOrganisationOwner } from "@/lib/connectors/organisationPage";
import { loadConnectionsScreen } from "@/lib/connectors/screenLoader";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ connectorId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : null);

/**
 * A connector's Listing (NEXT_PUBLIC_CONNECTORS_ENABLED), only while its own switch is on and a way
 * to connect is ready here; otherwise not found. Sign in with Google comes back here
 * (signInReturnPath): with `status=connected` and a connection that hasn't picked its property it
 * goes on to the picker, otherwise the page says how it went. `reconnect` names a token connection
 * that was turned down, which connecting again replaces. An owner of the brand's organisation,
 * read live while sharing is on, also gets "Connect for" (Connectors 3).
 */
export default async function ConnectorListingPage({ params, searchParams }: Params) {
  if (!isConnectorsScreenEnabled()) notFound();
  const [{ connectorId }, sp] = await Promise.all([params, searchParams]);
  const screen = await loadConnectionsScreen();
  if (!screen.core || screen.failed) return <ScreenUnavailable screen={screen} />;
  const listing = screen.connectors.find((c) => c.id === connectorId);
  if (!listing) notFound();
  const connections = screen.connections.filter((c) => c.connectorId === connectorId);

  const status = one(sp.status);
  const connectionId = one(sp.connection);
  const back = connectionId ? connections.find((c) => c.id === connectionId) : undefined;
  if (status === "connected" && back?.needsAccount && screen.isAdmin) redirect(pickPath(connectorId, back.id));
  const owner = screen.isAdmin ? await loadOrganisationOwner() : null;
  const organisation = owner ? await organisationListing(owner, connectorId).catch(() => null) : null;

  return (
    <ListingView
      listing={listing}
      connections={connections}
      isAdmin={screen.isAdmin}
      chat={screen.chat}
      banner={listingBanner({ status, reason: one(sp.reason), reconnected: one(sp.reconnected) === "1" })}
      replace={screen.isAdmin ? replaceableOf(connections, connectorId, one(sp.reconnect)) : null}
      organisation={organisation?.shareable ? organisation : null}
    />
  );
}
