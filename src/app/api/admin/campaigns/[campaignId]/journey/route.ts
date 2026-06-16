import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import { JourneyGraphSchema, JourneyStatus } from "@/lib/types/journey";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Deterministic one-journey-per-launch id. */
const journeyId = (campaignId: string) => `journey_${campaignId}`;

const SaveJourneySchema = z.object({
  graph: JourneyGraphSchema,
  status: JourneyStatus.optional(),
});

type RouteParams = { params: Promise<{ campaignId: string }> };

/** Fetch the launch's journey, or a default empty graph if none saved yet. */
export async function GET(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { campaignId } = await params;
  const id = journeyId(campaignId);
  const journey = await forTenant(ctx).journeys.getById(id);
  return NextResponse.json({
    journey:
      journey ?? {
        id,
        campaignId,
        status: "draft" as const,
        graph: { nodes: [], edges: [] },
      },
  });
}

/** Upsert the journey graph (draft autosave). */
export async function PUT(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { campaignId } = await params;
  const parsed = SaveJourneySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_input",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }

  const id = journeyId(campaignId);
  const now = new Date().toISOString();
  const existing = await forTenant(ctx).journeys.getById(id);
  if (existing) {
    await forTenant(ctx).journeys.update(id, {
      graph: parsed.data.graph,
      status: parsed.data.status ?? existing.status,
      updatedAt: now,
    });
  } else {
    const campaign = await forTenant(ctx).campaigns.getById(campaignId);
    if (!campaign) {
      return NextResponse.json({ error: "campaign_not_found" }, { status: 404 });
    }
    await forTenant(ctx).journeys.create(id, {
      campaignId,
      status: parsed.data.status ?? "draft",
      graph: parsed.data.graph,
      createdAt: now,
      updatedAt: now,
    });
  }

  const journey = await forTenant(ctx).journeys.getById(id);
  return NextResponse.json({ ok: true, journey });
}
