import { notFound } from "next/navigation";
import { BrowseView } from "@/components/admin/connectors/BrowseView";
import { ScreenUnavailable } from "@/components/admin/connectors/Notices";
import { isConnectorsScreenEnabled } from "@/lib/connectors/flags";
import { loadConnectionsScreen } from "@/lib/connectors/screenLoader";

export const dynamic = "force-dynamic";

/**
 * Settings › Connections › Browse (NEXT_PUBLIC_CONNECTORS_ENABLED): the connectors this copy
 * offers, each one only while its own switch is on and a way to connect is ready here.
 */
export default async function ConnectionsBrowsePage() {
  if (!isConnectorsScreenEnabled()) notFound();
  const screen = await loadConnectionsScreen();
  if (!screen.core || screen.failed) return <ScreenUnavailable screen={screen} />;
  return <BrowseView connectors={screen.connectors} connections={screen.connections} chat={screen.chat} />;
}
