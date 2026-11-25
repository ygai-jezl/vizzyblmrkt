import YourBrandHelp from "@/components/help/pages/your-brand";
import { helpMetadata } from "@/lib/help/metadata";

export const metadata = helpMetadata("your-brand");

/** A page of its own, so Next.js never passes the route's props to the help body. */
export default function Page() {
  return <YourBrandHelp />;
}
