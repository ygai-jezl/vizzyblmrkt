import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { isLifecycleEnabled } from "@/lib/lifecycle/flags";
import { JourneyEditor } from "@/components/admin/lifecycle/JourneyEditor";

export const dynamic = "force-dynamic";

/** One lifecycle journey: canvas, content, settings, delivery, people, preview, results. */
export default async function LifecycleJourneyPage({ params }: { params: Promise<{ journeyId: string }> }) {
  const ctx = await requireAdminContext();
  if (!isLifecycleEnabled()) notFound();
  const { journeyId } = await params;
  return <JourneyEditor journeyId={journeyId} canEdit={ctx.role === "admin"} />;
}
