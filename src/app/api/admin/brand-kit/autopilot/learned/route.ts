import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forgetLearned, readLearned } from "@/lib/autopilot/adminApi";
import { isNextUpEnabled } from "@/lib/autopilot/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What the autopilot learned from the brand's people. */
export async function GET(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  if (!isNextUpEnabled()) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const r = await readLearned(ctx);
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}

/** Admins forget one entry (`{ id }`) or all of them (`{ all: true }`). */
export async function DELETE(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  if (!isNextUpEnabled()) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (ctx.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const r = await forgetLearned(ctx, await req.json().catch(() => null));
  return NextResponse.json(r.body, { status: r.status });
}
