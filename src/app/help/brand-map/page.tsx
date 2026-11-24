import BrandMapHelp from "@/components/help/pages/brand-map";
import { helpMetadata } from "@/lib/help/metadata";

export const metadata = helpMetadata("brand-map");

/** A page of its own, so Next.js never passes the route's props to the help body. */
export default function Page() {
  return <BrandMapHelp />;
}
