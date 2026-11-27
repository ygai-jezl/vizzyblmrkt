import { notFound } from "next/navigation";
import WorkHelp from "@/components/help/pages/work";
import { helpMetadata } from "@/lib/help/metadata";
import { isWorkEnabled } from "@/lib/work/flags";

export const dynamic = "force-dynamic";
export const metadata = helpMetadata("work");

/** Served only while WORK_ENABLED is on. */
export default function Page() {
  if (!isWorkEnabled()) notFound();
  return <WorkHelp />;
}
