import InviteYourWaitlistHelp from "@/components/help/pages/invite-your-waitlist";
import { helpMetadata } from "@/lib/help/metadata";

export const metadata = helpMetadata("invite-your-waitlist");

/** A page of its own, so Next.js never passes the route's props to the help body. */
export default function Page() {
  return <InviteYourWaitlistHelp />;
}
