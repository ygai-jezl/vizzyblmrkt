import LaunchAndWaitlistHelp from "@/components/help/pages/launch-and-waitlist";
import { helpMetadata } from "@/lib/help/metadata";

/** Worked out per request, so the ideas sections follow LAUNCH_IDEAS_ENABLED (a runtime switch). */
export const dynamic = "force-dynamic";

/** Worked out per request too, so the title says Idea and waitlist while launches are called ideas. */
export function generateMetadata() {
  return helpMetadata("launch-and-waitlist");
}

export default function Page() {
  return <LaunchAndWaitlistHelp />;
}
