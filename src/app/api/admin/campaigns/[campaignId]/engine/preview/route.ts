import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { previewEngineMove } from "@/lib/lifecycle/waitlist/preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The engine-move dry run for one launch (engine move D3): what converting its
 * welcome journey to the lifecycle engine would produce, any blocking issues,
 * and how many people it would affect (counts only). Read-only; admins only.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ campaignId: string }> }) {
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (ctx.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { campaignId } = await params;
  const preview = await previewEngineMove(ctx, campaignId);
  if (!preview) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(preview, { headers: { "Cache-Control": "no-store" } });
}
