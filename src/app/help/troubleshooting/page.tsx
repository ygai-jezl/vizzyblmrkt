import TroubleshootingHelp from "@/components/help/pages/troubleshooting";
import { helpMetadata } from "@/lib/help/metadata";

export const metadata = helpMetadata("troubleshooting");

/** A page of its own, so Next.js never passes the route's props to the help body. */
export default function Page() {
  return <TroubleshootingHelp />;
}
