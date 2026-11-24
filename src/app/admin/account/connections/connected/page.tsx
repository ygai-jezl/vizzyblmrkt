import { notFound } from "next/navigation";
import { ConnectedView } from "@/components/admin/connectors/ConnectedView";
import { ScreenUnavailable } from "@/components/admin/connectors/Notices";
import { isConnectorsScreenEnabled } from "@/lib/connectors/flags";
import { loadConnectionsScreen } from "@/lib/connectors/screenLoader";
import { DATA_CONNECTION_ID_RE } from "@/lib/types/dataConnection";

export const dynamic = "force-dynamic";

/**
 * Settings › Connections › Connected (NEXT_PUBLIC_CONNECTORS_ENABLED): the brand's connections,
 * their health and, for admins, who may read each one, Check now, Pause, Resume, Disconnect and
 * the recent activity. A connection whose connector is switched off stays listed, reading nothing.
 * `?c=<id>` opens on that connection (a Review row for a data source links here with it).
 */
export default async function ConnectedPage({ searchParams }: { searchParams: Promise<{ c?: string | string[] }> }) {
  if (!isConnectorsScreenEnabled()) notFound();
  const screen = await loadConnectionsScreen();
  if (!screen.core || screen.failed) return <ScreenUnavailable screen={screen} />;
  const c = (await searchParams).c;
  const wanted = typeof c === "string" && DATA_CONNECTION_ID_RE.test(c) ? c : null;
  return (
    <ConnectedView
      // A new `c` (a Review link or a search result, opened while already here) selects it afresh.
      key={wanted ?? "none"}
      connections={screen.connections}
      isAdmin={screen.isAdmin}
      uid={screen.uid}
      chat={screen.chat}
      collect={screen.collect}
      planning={screen.planning}
      selected={wanted}
      now={new Date().toISOString()}
    />
  );
}
