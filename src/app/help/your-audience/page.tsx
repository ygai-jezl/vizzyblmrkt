import { notFound } from "next/navigation";
import YourAudienceHelp from "@/components/help/pages/your-audience";
import { helpMetadata } from "@/lib/help/metadata";
import { isOneViewEnabled } from "@/lib/audience/flags";

export const dynamic = "force-dynamic";
export const metadata = helpMetadata("your-audience");

/** Served only while AUDIENCE_ONE_VIEW_ENABLED is on. */
export default function Page() {
  if (!isOneViewEnabled()) notFound();
  return <YourAudienceHelp />;
}
