import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { listContacts } from "@/lib/admin/crm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** CRM Contacts tab: search + filter + keyset-paginated list (newest first). */
export async function GET(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sp = new URL(req.url).searchParams;
  const { items, nextCursor } = await listContacts(ctx, {
    q: sp.get("q") ?? undefined,
    campaignId: sp.get("campaignId") ?? undefined,
    corporate: sp.get("corporate") === "1",
    enriched: sp.get("enriched") === "1",
    cursor: sp.get("cursor") ?? undefined,
  });
  return NextResponse.json({ contacts: items, nextCursor });
}
