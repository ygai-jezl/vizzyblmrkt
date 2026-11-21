import ConnectYourProductHelp from "@/components/help/pages/connect-your-product";
import { helpMetadata } from "@/lib/help/metadata";

export const metadata = helpMetadata("connect-your-product");

/** A page of its own, so Next.js never passes the route's props to the help body. */
export default function Page() {
  return <ConnectYourProductHelp />;
}
