import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { readMarket, saveMarket } from "@/lib/signals/adminApi";
import { isBrandSignalsEnabled } from "@/lib/signals/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The brand's Google market (where its questions are looked up) and the choices. */
export async function GET(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  if (!isBrandSignalsEnabled()) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const r = await readMarket(ctx);
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}

/** Admins choose the market: `{ market: { country, language } }`, or `{ market: null }` for the default. */
export async function PUT(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  if (!isBrandSignalsEnabled()) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (ctx.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const r = await saveMarket(ctx, await req.json().catch(() => null));
  return NextResponse.json(r.body, { status: r.status });
}
