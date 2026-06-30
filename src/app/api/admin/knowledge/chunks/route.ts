import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant, listKnowledgeChunks } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Browse the chunks a source produced. Scoped via the ticket's owner. */
export async function GET(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const ticketId = new URL(req.url).searchParams.get("ticketId");
  if (!ticketId) return NextResponse.json({ error: "ticketId_required" }, { status: 400 });

  const ticket = await forTenant(ctx).ingestionTickets.getById(ticketId);
  if (!ticket) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const chunks = await listKnowledgeChunks(ctx, ticket.ownerKind, ticket.ownerId, {
    ticketId,
    limit: 200,
  });
  return NextResponse.json({ chunks });
}
