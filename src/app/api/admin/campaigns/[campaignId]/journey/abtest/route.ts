import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { promoteVariant } from "@/lib/journey/abTest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ campaignId: string }> };

/** Require a meaningful sample before a winner can be promoted (anti-noise). */
const MIN_SAMPLE = 50;

const PromoteSchema = z.object({
  action: z.literal("promote"),
  nodeId: z.string().min(1),
  winnerVariantId: z.string().min(1),
});

/**
 * Promote an A/B winner for one email node. Human-only path (the Analytics
 * drill-in) — deliberately NOT reachable from the agent canvas, mirroring how
 * journey activation stays off the agent path.
 */
export async function POST(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { campaignId } = await params;
  const parsed = PromoteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }

  const res = await promoteVariant(
    ctx,
    campaignId,
    parsed.data.nodeId,
    parsed.data.winnerVariantId,
    { requireMinSample: MIN_SAMPLE },
  );
  if (!res.ok) {
    const status = res.error === "insufficient_data" ? 409 : 404;
    return NextResponse.json({ error: res.error }, { status });
  }
  return NextResponse.json({ ok: true });
}
