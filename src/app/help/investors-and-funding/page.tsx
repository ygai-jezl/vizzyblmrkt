import { notFound } from "next/navigation";
import InvestorsAndFundingHelp from "@/components/help/pages/investors-and-funding";
import { helpMetadata } from "@/lib/help/metadata";
import { isRaisePipelineEnabled } from "@/lib/raise/pipeline/flags";

export const dynamic = "force-dynamic";
export const metadata = helpMetadata("investors-and-funding");

/** Served only while RAISE_PIPELINE_ENABLED is on. */
export default function Page() {
  if (!isRaisePipelineEnabled()) notFound();
  return <InvestorsAndFundingHelp />;
}
