import { notFound } from "next/navigation";
import { ConnectedView } from "@/components/admin/connectors/ConnectedView";
import { ScreenUnavailable } from "@/components/admin/connectors/Notices";
import { isConnectorsScreenEnabled } from "@/lib/connectors/flags";
import { loadConnectionsScreen } from "@/lib/connectors/screenLoader";

export const dynamic = "force-dynamic";

/**
 * Settings › Connections › Connected (NEXT_PUBLIC_CONNECTORS_ENABLED): the brand's connections,
 * their health and, for admins, who may read each one, Check now, Pause, Resume, Disconnect and
 * the recent activity. A connection whose connector is switched off stays listed, reading nothing.
 */
export default async function ConnectedPage() {
  if (!isConnectorsScreenEnabled()) notFound();
  const screen = await loadConnectionsScreen();
  if (!screen.core || screen.failed) return <ScreenUnavailable screen={screen} />;
  return <ConnectedView connections={screen.connections} isAdmin={screen.isAdmin} uid={screen.uid} chat={screen.chat} now={new Date().toISOString()} />;
}
