import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Poll a single ingestion ticket's status (tenant-scoped). */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ ticketId: string }> },
) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { ticketId } = await params;
  const ticket = await forTenant(ctx).ingestionTickets.getById(ticketId);
  if (!ticket) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ticket });
}
