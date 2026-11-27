import { notFound } from "next/navigation";
import WhatYouGrowLearnedHelp from "@/components/help/pages/what-yougrow-learned";
import { helpMetadata } from "@/lib/help/metadata";
import { helpPage, isHelpPageShown } from "@/lib/help/pages";

export const dynamic = "force-dynamic";
export const metadata = helpMetadata("what-yougrow-learned");

/**
 * Served while the page is listed: image style versions (IMAGE_STYLE_VERSIONS_ENABLED) or the
 * learning loops (LOOPS_ENABLED) are on, the same rule as the /help list and llms.txt.
 */
export default function Page() {
  const page = helpPage("what-yougrow-learned");
  if (!page || !isHelpPageShown(page)) notFound();
  return <WhatYouGrowLearnedHelp />;
}
