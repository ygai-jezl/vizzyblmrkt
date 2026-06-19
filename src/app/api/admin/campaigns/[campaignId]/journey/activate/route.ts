import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import {
  activateJourney,
  processEmailJobs,
  validateJourneyGraph,
} from "@/lib/email/delivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ActionSchema = z.object({ action: z.enum(["activate", "pause"]) });

/**
 * Activate the journey (enqueue the first email step for every verified
 * subscriber, then kick the worker for the due ones) or pause it (in-flight
 * steps stop sending — see processJourneyStepJob).
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { campaignId } = await params;
  const parsed = ActionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }

  const id = `journey_${campaignId}`;
  const journey = await forTenant(ctx).journeys.getById(id);
  if (!journey) {
    return NextResponse.json({ error: "journey_not_found" }, { status: 404 });
  }
  const now = new Date().toISOString();

  if (parsed.data.action === "pause") {
    await forTenant(ctx).journeys.update(id, { status: "paused", updatedAt: now });
    return NextResponse.json({ ok: true, status: "paused" });
  }

  // Refuse to activate an empty/half-wired journey: it would flip to "active",
  // enqueue nobody, and silently send nothing — the worst kind of failure.
  const valid = validateJourneyGraph(journey.graph);
  if (!valid.ok) {
    return NextResponse.json(
      { error: "journey_invalid", reason: valid.reason },
      { status: 422 },
    );
  }

  await forTenant(ctx).journeys.update(id, { status: "active", updatedAt: now });
  const fresh = await forTenant(ctx).journeys.getById(id);
  const { enqueued } = await activateJourney(ctx, fresh!);
  const result = await processEmailJobs(ctx);
  return NextResponse.json({ ok: true, status: "active", enqueued, result });
}
