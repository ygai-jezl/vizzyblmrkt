import { notFound } from "next/navigation";
import PlanAndUsageHelp from "@/components/help/pages/plan-and-usage";
import { helpMetadata } from "@/lib/help/metadata";
import { isPlansUiEnabled } from "@/lib/plans/flags";

export const dynamic = "force-dynamic";
export const metadata = helpMetadata("plan-and-usage");

/** Served only while NEXT_PUBLIC_PLANS_ENABLED is on. */
export default function Page() {
  if (!isPlansUiEnabled()) notFound();
  return <PlanAndUsageHelp />;
}
