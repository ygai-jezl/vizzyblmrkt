import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { lookupStatus, startLookup } from "@/lib/signals/adminApi";
import { isSignalsDataForSeoEnabled } from "@/lib/signals/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

/** Whether "Get from Google" can be offered for this brand, its market and this month's use. */
export async function GET(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  if (!isSignalsDataForSeoEnabled()) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const r = await lookupStatus(ctx);
  return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
}

/** Look a question up on Google (SIGNALS_DATAFORSEO_ENABLED): `{ query, questionId?, subjectId? }`. */
export async function POST(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  if (!isSignalsDataForSeoEnabled()) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const r = await startLookup(ctx, await req.json().catch(() => null));
  return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
}
