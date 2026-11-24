import { notFound } from "next/navigation";
import SharedConnectionsHelp from "@/components/help/pages/shared-connections";
import { helpMetadata } from "@/lib/help/metadata";
import { isConnectorsSharingEnabled } from "@/lib/connectors/flags";

export const dynamic = "force-dynamic";
export const metadata = helpMetadata("shared-connections");

/** Served only while CONNECTORS_SHARING_ENABLED is on (with CONNECTORS_ENABLED and PLANS_ENABLED). */
export default function Page() {
  if (!isConnectorsSharingEnabled()) notFound();
  return <SharedConnectionsHelp />;
}
