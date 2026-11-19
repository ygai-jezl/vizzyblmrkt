import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { readNextUpApi, refreshNextUp } from "@/lib/autopilot/adminApi";
import { isNextUpEnabled } from "@/lib/autopilot/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The brand's Next up: its three best next articles, with why. */
export async function GET(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  if (!isNextUpEnabled()) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const r = await readNextUpApi(ctx);
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}

/** Choose again now. */
export async function POST(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  if (!isNextUpEnabled()) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const r = await refreshNextUp(ctx);
  return NextResponse.json(r.body, { status: r.status });
}
