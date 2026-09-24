import { redirect } from "next/navigation";
import { requireAdminContext } from "@/lib/auth/session";
import { waitlistJourneyId } from "@/lib/lifecycle/waitlist/ids";
import { legacyEditorMode } from "@/lib/journey/flags";
import { forTenant } from "@/lib/tenant";
import { JourneyCanvas } from "@/components/admin/journey/JourneyCanvas";
import { isNavV2Phase3Enabled } from "@/lib/nav/flags";
import type { Journey } from "@/lib/types/journey";

export const dynamic = "force-dynamic";

export default async function LaunchJourneyPage({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const ctx = await requireAdminContext();
  const { campaignId } = await params;
  const id = `journey_${campaignId}`;
  const [existing, campaign] = await Promise.all([
    forTenant(ctx).journeys.getById(id),
    forTenant(ctx).campaigns.getById(campaignId),
  ]);
  // A launch moved to the lifecycle engine (engine move) is edited there.
  if (campaign?.waitlistEngine === "lifecycle") {
    const moved = await forTenant(ctx).lifecycleJourneys.getById(waitlistJourneyId(campaignId));
    if (moved) redirect(`/admin/lifecycle/${moved.id}`);
  }
  // Engine move D6: the original editor is retired — move the launch from its Settings.
  const editor = legacyEditorMode();
  if (editor === "retired") redirect(`/admin/launches/${campaignId}/settings`);
  const journey: Journey =
    existing ?? {
      id,
      tenantId: ctx.tenantId,
      campaignId,
      status: "draft",
      graph: { nodes: [], edges: [] },
      createdAt: "",
      updatedAt: "",
    };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold">{isNavV2Phase3Enabled() ? "Welcome & nurture" : "Journey"}</h2>
        <p className="text-sm text-neutral-500">
          {isNavV2Phase3Enabled()
            ? "The automated emails everyone who joins this launch receives. Build them on the canvas, then publish."
            : "Automated email sequence for this launch. Build it on the canvas, then activate."}
        </p>
      </div>
      <JourneyCanvas
        campaignId={campaignId}
        initial={journey}
        questions={campaign?.questions ?? []}
        readOnly={editor === "read_only"}
      />
    </div>
  );
}
