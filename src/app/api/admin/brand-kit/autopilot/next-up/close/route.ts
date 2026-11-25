import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { closePick } from "@/lib/autopilot/adminApi";
import { isNextUpRepeatsEnabled } from "@/lib/autopilot/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A pick close to a live article: `{ questionId, action: "add" | "write_anyway" }`. Kept on the Learned list. */
export async function POST(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  if (!isNextUpRepeatsEnabled()) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const r = await closePick(ctx, await req.json().catch(() => null));
  return NextResponse.json(r.body, { status: r.status });
}
