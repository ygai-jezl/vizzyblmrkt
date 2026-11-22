import { ConnectionsTabs } from "@/components/admin/connectors/ConnectionsTabs";
import { isConnectorsScreenEnabled } from "@/lib/connectors/flags";
import { loadConnectionsScreen } from "@/lib/connectors/screenLoader";
import { connectedCount } from "@/lib/connectors/screens";

export const dynamic = "force-dynamic";

/**
 * Settings › Connections. With NEXT_PUBLIC_CONNECTORS_ENABLED on it has three sub-tabs: Accounts
 * (today's GitHub, GitLab, LinkedIn and X panel, still on this base route because every sign in
 * callback returns here), Browse and Connected. Off, it is the Accounts panel alone, as before.
 */
export default async function ConnectionsLayout({ children }: { children: React.ReactNode }) {
  if (!isConnectorsScreenEnabled()) return <>{children}</>;
  const screen = await loadConnectionsScreen();
  return (
    <div className="space-y-5">
      <ConnectionsTabs connected={screen.core && !screen.failed ? connectedCount(screen) : null} />
      <div>{children}</div>
    </div>
  );
}
