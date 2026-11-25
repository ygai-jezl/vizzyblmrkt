import GetSetUpHelp from "@/components/help/pages/get-set-up";
import { helpMetadata } from "@/lib/help/metadata";

export const metadata = helpMetadata("");

/** Worked out per request, so stage 2's name follows LAUNCH_IDEAS_ENABLED (a runtime switch). */
export const dynamic = "force-dynamic";

/** A page of its own, so Next.js never passes the route's props to the help body. */
export default function Page() {
  return <GetSetUpHelp />;
}
