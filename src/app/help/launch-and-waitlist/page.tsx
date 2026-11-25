import LaunchAndWaitlistHelp from "@/components/help/pages/launch-and-waitlist";
import { helpMetadata } from "@/lib/help/metadata";

export const metadata = helpMetadata("launch-and-waitlist");

/** Worked out per request, so the ideas sections follow LAUNCH_IDEAS_ENABLED (a runtime switch). */
export const dynamic = "force-dynamic";

export default function Page() {
  return <LaunchAndWaitlistHelp />;
}
