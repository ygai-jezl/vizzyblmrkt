import { notFound } from "next/navigation";
import WhatYouGrowLearnedHelp from "@/components/help/pages/what-yougrow-learned";
import { helpMetadata } from "@/lib/help/metadata";
import { isImageStyleVersionsOn } from "@/lib/content/imageStyle/flags";

export const dynamic = "force-dynamic";
export const metadata = helpMetadata("what-yougrow-learned");

/** Served only while image style versions are on (IMAGE_STYLE_VERSIONS_ENABLED). */
export default function Page() {
  if (!isImageStyleVersionsOn()) notFound();
  return <WhatYouGrowLearnedHelp />;
}
