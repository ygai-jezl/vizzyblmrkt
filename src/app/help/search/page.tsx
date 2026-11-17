import { notFound } from "next/navigation";
import SearchHelp from "@/components/help/pages/search";
import { helpMetadata } from "@/lib/help/metadata";
import { isSearchUiEnabled } from "@/lib/search/flags";

export const dynamic = "force-dynamic";
export const metadata = helpMetadata("search");

/** Served only while NEXT_PUBLIC_SEARCH_ENABLED is on. */
export default function Page() {
  if (!isSearchUiEnabled()) notFound();
  return <SearchHelp />;
}
