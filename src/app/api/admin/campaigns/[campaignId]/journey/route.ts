import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import { JourneyGraphSchema, JourneyStatus } from "@/lib/types/journey";
import { journeyIdFor, upsertJourneyDraft } from "@/lib/journey/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  const id = journeyIdFor(campaignId);
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

  const saved = await upsertJourneyDraft(ctx, campaignId, parsed.data.graph, {
    status: parsed.data.status,
  });
  if (!saved.ok) {
    return NextResponse.json({ error: saved.error }, { status: 404 });
  }
  return NextResponse.json({ ok: true, journey: saved.journey });
}
