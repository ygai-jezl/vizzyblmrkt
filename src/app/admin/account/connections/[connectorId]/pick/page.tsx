import { notFound } from "next/navigation";
import { ScreenUnavailable } from "@/components/admin/connectors/Notices";
import { PropertyPicker } from "@/components/admin/connectors/PropertyPicker";
import { NOTE_PLAIN, PICKER_COPY, listedNoteOf } from "@/components/admin/connectors/words";
import { requireAdminContext } from "@/lib/auth/session";
import { isConnectorsScreenEnabled } from "@/lib/connectors/flags";
import { loadConnectionsScreen } from "@/lib/connectors/screenLoader";
import { getTenantById } from "@/lib/tenant";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ connectorId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * Choose the site or property a signed in or shared connection reads
 * (NEXT_PUBLIC_CONNECTORS_ENABLED; the connector's own switch on). `connection` names it. Admins
 * only, as the accounts route is; the brand's root domain lets the picker mark a property on
 * another website, never blocking it.
 */
export default async function PickPropertyPage({ params, searchParams }: Params) {
  if (!isConnectorsScreenEnabled()) notFound();
  const [{ connectorId }, sp] = await Promise.all([params, searchParams]);
  const screen = await loadConnectionsScreen();
  if (!screen.core || screen.failed) return <ScreenUnavailable screen={screen} />;
  const listing = screen.connectors.find((c) => c.id === connectorId);
  if (!listing) notFound();
  if (!screen.isAdmin) return <p className={NOTE_PLAIN}>{PICKER_COPY.adminsOnly}</p>;
  const id = typeof sp.connection === "string" ? sp.connection : "";
  const conn = screen.connections.find((c) => c.id === id && c.connectorId === connectorId && c.status === "connected");
  const method = conn?.details?.method;
  if (!conn || !conn.details || (method !== "oauth_pkce" && method !== "share_access")) return <p className={NOTE_PLAIN}>{PICKER_COPY.gone}</p>;

  const ctx = await requireAdminContext();
  const tenant = await getTenantById(ctx.tenantId).catch(() => null);
  return (
    <PropertyPicker
      connectorId={connectorId}
      connectorName={listing.name}
      connectorIcon={listing.icon}
      connectorInitials={listing.initials}
      connectionId={conn.id}
      method={method}
      sharedWith={conn.details.serviceAccount?.email ?? null}
      current={conn.details.account}
      rootDomain={tenant?.rootDomain?.trim() || null}
      listedNote={listedNoteOf(listing)}
    />
  );
}
