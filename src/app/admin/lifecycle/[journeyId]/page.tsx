import { notFound } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { isLifecycleEnabled } from "@/lib/lifecycle/flags";
import { isWaitlistEngineUiEnabled } from "@/lib/lifecycle/waitlist/flags";
import { JourneyEditor } from "@/components/admin/lifecycle/JourneyEditor";

export const dynamic = "force-dynamic";

/** One lifecycle journey: canvas, content, settings, delivery, people, preview, results — or a launch's moved welcome journey. */
export default async function LifecycleJourneyPage({ params }: { params: Promise<{ journeyId: string }> }) {
  const ctx = await requireAdminContext();
  if (!isLifecycleEnabled() && !isWaitlistEngineUiEnabled()) notFound();
  const { journeyId } = await params;
  return <JourneyEditor journeyId={journeyId} canEdit={ctx.role === "admin"} />;
}
