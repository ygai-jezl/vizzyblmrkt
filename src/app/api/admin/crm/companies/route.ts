import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { listCompanies } from "@/lib/admin/crm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** CRM Companies tab: search + keyset-paginated list (newest activity first). */
export async function GET(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const { items, nextCursor } = await listCompanies(ctx, {
    q: url.searchParams.get("q") ?? undefined,
    cursor: url.searchParams.get("cursor") ?? undefined,
  });
  return NextResponse.json({ companies: items, nextCursor });
}
