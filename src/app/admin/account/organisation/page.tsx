import { notFound } from "next/navigation";
import { SharedConnectionsView } from "@/components/admin/connectors/SharedConnectionsView";
import { NOTE_ERR, SHARED_COPY } from "@/components/admin/connectors/words";
import { sharedConnectionsScreen, type SharedConnectionsScreen } from "@/lib/connectors/organisationConnect";
import { loadOrganisationOwner } from "@/lib/connectors/organisationPage";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : null);

/**
 * Settings › Organisation › Shared connections (CONNECTORS_SHARING_ENABLED): the organisation's
 * connections from every region and who gets which part, read on the server for an owner. A
 * connect or sign in for the organisation comes back here (`status`, `connection`).
 */
export default async function OrganisationPage({ searchParams }: Props) {
  const owner = await loadOrganisationOwner();
  if (!owner) notFound();
  const sp = await searchParams;
  let screen: SharedConnectionsScreen | null = null;
  try {
    screen = await sharedConnectionsScreen(owner);
  } catch (err) {
    console.warn("[organisation] Shared connections didn't load", err instanceof Error ? err.message.slice(0, 200) : "error");
  }
  if (!screen) {
    return (
      <p role="alert" className={NOTE_ERR}>
        {SHARED_COPY.failed}
      </p>
    );
  }
  return <SharedConnectionsView screen={screen} back={{ status: one(sp.status), connection: one(sp.connection) }} now={new Date().toISOString()} />;
}
