import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { listEngagedContacts } from "@/lib/admin/crm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** CRM Engaged tab: keyset-paginated list of social-engaged contacts (newest first). */
export async function GET(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sp = new URL(req.url).searchParams;
  const { items, nextCursor } = await listEngagedContacts(ctx, {
    cursor: sp.get("cursor") ?? undefined,
  });
  return NextResponse.json({ contacts: items, nextCursor });
}
