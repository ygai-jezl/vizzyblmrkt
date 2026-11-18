import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { readLookup } from "@/lib/signals/adminApi";
import { isSignalsDataForSeoEnabled } from "@/lib/signals/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One Google lookup of this brand's, collected now when DataForSEO should have finished it. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  if (!isSignalsDataForSeoEnabled()) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const r = await readLookup(ctx, id);
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
