import PeopleHelp from "@/components/help/pages/people";
import { helpMetadata } from "@/lib/help/metadata";

export const metadata = helpMetadata("people");

/** A page of its own, so Next.js never passes the route's props to the help body. */
export default function Page() {
  return <PeopleHelp />;
}
