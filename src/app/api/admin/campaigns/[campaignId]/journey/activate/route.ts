import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { setJourneyState } from "@/lib/journey/service";

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

  const result = await setJourneyState(ctx, campaignId, parsed.data.action);
  if (!result.ok) {
    const status = result.error === "journey_not_found" ? 404 : 422;
    return NextResponse.json(
      { error: result.error, ...(result.reason ? { reason: result.reason } : {}) },
      { status },
    );
  }
  return NextResponse.json(result);
}
