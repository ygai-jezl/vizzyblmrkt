import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { readRunApi } from "@/lib/autopilot/adminApi";
import { isNextUpEnabled } from "@/lib/autopilot/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One run of this brand's, advanced a step first when it's due. */
export async function GET(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  if (!isNextUpEnabled()) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { runId } = await params;
  const r = await readRunApi(ctx, runId);
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
