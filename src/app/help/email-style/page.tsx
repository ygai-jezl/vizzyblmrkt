import EmailStyleHelp from "@/components/help/pages/email-style";
import { helpMetadata } from "@/lib/help/metadata";

export const metadata = helpMetadata("email-style");

/** A page of its own, so Next.js never passes the route's props to the help body. */
export default function Page() {
  return <EmailStyleHelp />;
}
