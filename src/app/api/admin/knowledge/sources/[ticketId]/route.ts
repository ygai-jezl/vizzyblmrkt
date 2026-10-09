import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant, deleteOwnerKnowledge, setKnowledgeTags } from "@/lib/tenant";
import { isCiteSource, isCiteSourcesEnabled, isWebSource, withCiteTag } from "@/lib/knowledge/cite";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ ticketId: string }> };

const PatchSchema = z.object({
  /** Whether an article may cite this source. */
  cite: z.boolean(),
});

/**
 * Mark a source as one an article may cite, or take the mark away — without reading the
 * source again. The mark is the `cite` tag, and retrieval filters on the tags stamped on
 * a source's chunks, so those are re-stamped first and the source itself second: if the
 * re-stamp fails part-way the source still says what it said, and a second try finishes
 * the job. Refused while the source is being read (the worker would stamp the old tags
 * over the new ones). FLAG-GATED (503 until CREATE_BLOG_CITE_SOURCES_ENABLED).
 */
export async function PATCH(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isCiteSourcesEnabled()) return NextResponse.json({ error: "unavailable" }, { status: 503 });

  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  const { ticketId } = await params;
  const repo = forTenant(ctx).ingestionTickets;
  const ticket = await repo.getById(ticketId);
  if (!ticket) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // An article cites a page. A code repo is not one.
  if (!isWebSource(ticket.source)) return NextResponse.json({ error: "not_a_web_source" }, { status: 409 });
  if (ticket.status === "pending" || ticket.status === "running" || ticket.status === "embedding") {
    return NextResponse.json({ error: "source_busy" }, { status: 409 });
  }

  const tags = withCiteTag(ticket.tags, parsed.data.cite);
  if (isCiteSource(ticket.tags) === parsed.data.cite) return NextResponse.json({ ticket, updatedChunks: 0 });

  const updatedChunks = await setKnowledgeTags(ctx, ticket.ownerKind, ticket.ownerId, { ticketId, tags });
  await repo.update(ticketId, { tags });
  return NextResponse.json({ ticket: { ...ticket, tags }, updatedChunks });
}

/** Delete a source: its chunks + the ticket. (To change a source's topic or its other
 *  tags, re-ingest it — that re-stamps the chunks too, keeping the filter consistent.) */
export async function DELETE(req: Request, { params }: RouteParams) {
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
