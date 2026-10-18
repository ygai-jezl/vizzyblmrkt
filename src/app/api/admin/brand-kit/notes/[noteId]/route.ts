import { notesAdmin, removeFromRequest, updateFromRequest } from "@/lib/brandNotes/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ noteId: string }> };

/** Change one of the brand's notes, or keep one Vizzy suggested (admins). */
export async function PATCH(req: Request, { params }: RouteParams) {
  const g = await notesAdmin(req);
  if (!g.ok) return g.response;
  const { noteId } = await params;
  return updateFromRequest(g.ctx, noteId, await req.json().catch(() => null));
}

/** Remove one of the brand's notes (admins). Articles already written keep what they said. */
export async function DELETE(req: Request, { params }: RouteParams) {
  const g = await notesAdmin(req);
  if (!g.ok) return g.response;
  const { noteId } = await params;
  return removeFromRequest(g.ctx, noteId);
}
