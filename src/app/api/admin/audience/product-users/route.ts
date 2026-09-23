import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { isLifecycleEnabled } from "@/lib/lifecycle/flags";
import { isNavV2Phase3Enabled } from "@/lib/nav/flags";
import { AUDIENCE_PRODUCT_USERS_LIMIT, loadAudienceProductUsers } from "@/lib/audience/productUsers";

export const dynamic = "force-dynamic";

/** Audience → Product users (nav v2 phase 3): the most recently seen users of your connected products. */
export async function GET(req: Request) {
  if (!isNavV2Phase3Enabled() || !isLifecycleEnabled()) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const users = await loadAudienceProductUsers(ctx);
  return NextResponse.json(
    { users, limit: AUDIENCE_PRODUCT_USERS_LIMIT },
    { headers: { "cache-control": "no-store" } },
  );
}
