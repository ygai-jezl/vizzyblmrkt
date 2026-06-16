import { requireAdminContext } from "@/lib/auth/session";
import { forTenant } from "@/lib/tenant";
import { JourneyCanvas } from "@/components/admin/journey/JourneyCanvas";
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
  const existing = await forTenant(ctx).journeys.getById(id);
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
        <h2 className="text-sm font-semibold">Journey</h2>
        <p className="text-sm text-neutral-500">
          Automated email sequence for this launch. Build it on the canvas, then
          activate.
        </p>
      </div>
      <JourneyCanvas campaignId={campaignId} initial={journey} />
    </div>
  );
}
