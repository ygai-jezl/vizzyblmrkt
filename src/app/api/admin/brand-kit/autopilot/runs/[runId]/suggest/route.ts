import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { suggestOthers } from "@/lib/autopilot/adminApi";
import { isNextUpEnabled } from "@/lib/autopilot/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Admins file "Another subject" items as brand map suggestions: `{ texts: string[] }`. */
export async function POST(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  if (!isNextUpEnabled()) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (ctx.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { runId } = await params;
  const r = await suggestOthers(ctx, runId, await req.json().catch(() => null));
  return NextResponse.json(r.body, { status: r.status });
}
