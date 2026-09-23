import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { isLifecycleEnabled } from "@/lib/lifecycle/flags";
import { isNavV2Phase2Enabled } from "@/lib/nav/flags";
import { countReview } from "@/lib/review/summary";

export const dynamic = "force-dynamic";

/** How many decisions wait in Review, for the sidebar badge (nav v2 phase 2). */
export async function GET(req: Request) {
  if (!isNavV2Phase2Enabled()) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const count = await countReview(ctx, { lifecycle: isLifecycleEnabled() });
  return NextResponse.json({ count }, { headers: { "cache-control": "no-store" } });
}
