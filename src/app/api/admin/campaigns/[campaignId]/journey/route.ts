import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import { JourneyGraphSchema } from "@/lib/types/journey";
import { journeyIdFor, upsertJourneyDraft } from "@/lib/journey/service";
import { legacyEditorMode } from "@/lib/journey/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Saving never changes a journey's status: that goes through Publish/Pause
// (activate/route.ts), which validates, enrols and releases held steps.
const SaveJourneySchema = z.object({
  graph: JourneyGraphSchema,
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
  // Engine move D6: the original editor is retired — welcome emails are built in the new one.
  if (legacyEditorMode() !== "edit") {
    return NextResponse.json(
      { error: "original_editor_retired", message: "Welcome emails are now built in the new journey editor. Move this launch in its Settings." },
      { status: 409 },
    );
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (body && "status" in body) {
    return NextResponse.json(
      { error: "status_not_allowed", message: "Use Publish or Pause to change a journey's status." },
      { status: 400 },
    );
  }
  const parsed = SaveJourneySchema.safeParse(body);
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

  const saved = await upsertJourneyDraft(ctx, campaignId, parsed.data.graph);
  if (!saved.ok) {
    return NextResponse.json({ error: saved.error }, { status: 404 });
  }
  return NextResponse.json({ ok: true, journey: saved.journey });
}
