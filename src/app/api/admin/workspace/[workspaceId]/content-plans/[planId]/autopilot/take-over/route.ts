import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { takeOver } from "@/lib/autopilot/takeOver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ workspaceId: string; planId: string }> };

/** Take a workflow back from the article autopilot: the run stops and edits save again. */
export async function POST(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspaceId, planId } = await params;
  const r = await takeOver(ctx, workspaceId, planId);
  return NextResponse.json(r.body, { status: r.status });
}
