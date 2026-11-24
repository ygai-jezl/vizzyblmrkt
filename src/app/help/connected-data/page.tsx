import { notFound } from "next/navigation";
import ConnectedDataHelp from "@/components/help/pages/connected-data";
import { helpMetadata } from "@/lib/help/metadata";
import { isConnectorsScreenEnabled } from "@/lib/connectors/flags";

export const dynamic = "force-dynamic";
export const metadata = helpMetadata("connected-data");

/** Served only while NEXT_PUBLIC_CONNECTORS_ENABLED is on. */
export default function Page() {
  if (!isConnectorsScreenEnabled()) notFound();
  return <ConnectedDataHelp />;
}
