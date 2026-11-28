import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { isLoopsEnabled } from "@/lib/loops/flags";
import { loopsSection } from "@/lib/loops/loopsSection";
import { isLoopsOperator } from "@/lib/loops/operators";
import { LoopsSection } from "@/components/admin/settings/LoopsSection";

export const dynamic = "force-dynamic";

/**
 * Settings › Loops (LOOPS_ENABLED, learning loops step 5): the counts across every brand in this
 * copy, for closed weeks, by organisation. Only the people LOOPS_OPERATOR_EMAILS names see it,
 * with a verified address; for anyone else, or with the switch off, it is not found and its tab
 * isn't there. The week is a search parameter (one of the last 2 closed weeks); the page reads
 * only those weeks' fh: rows, by id, in one batched read. The sidebar doesn't change.
 */
export default async function LoopsPage({ searchParams }: { searchParams: Promise<{ week?: string | string[] }> }) {
  const ctx = await requireAdminContext();
  if (!isLoopsEnabled() || !isLoopsOperator(ctx)) notFound();
  const { week } = await searchParams;
  const view = await loopsSection({ week: typeof week === "string" ? week : null, now: new Date() });
  return <LoopsSection view={view} />;
}
