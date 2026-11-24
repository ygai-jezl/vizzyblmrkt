import WriteAndScheduleHelp from "@/components/help/pages/write-and-schedule";
import { helpMetadata } from "@/lib/help/metadata";

export const metadata = helpMetadata("write-and-schedule");

/** A page of its own, so Next.js never passes the route's props to the help body. */
export default function Page() {
  return <WriteAndScheduleHelp />;
}
