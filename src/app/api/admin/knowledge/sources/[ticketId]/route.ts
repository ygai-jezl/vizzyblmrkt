import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant, deleteOwnerKnowledge } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Delete a source: its chunks + the ticket. (To change a source's topic/tags,
 *  re-ingest it — that re-stamps the chunks too, keeping the filter consistent.) */
export async function DELETE(
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

  const deletedChunks = await deleteOwnerKnowledge(ctx, ticket.ownerKind, ticket.ownerId, {
    ticketId,
  });
  await forTenant(ctx).ingestionTickets.delete(ticketId);
  return NextResponse.json({ ok: true, deletedChunks });
}
