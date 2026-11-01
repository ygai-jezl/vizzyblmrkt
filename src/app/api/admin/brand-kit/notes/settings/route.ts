import { notesAdmin, restFromRequest } from "@/lib/brandNotes/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Brand › What we've seen: how often a note goes into articles by itself (admins). */
export async function PUT(req: Request) {
  const g = await notesAdmin(req);
  if (!g.ok) return g.response;
  return restFromRequest(g.ctx, await req.json().catch(() => null));
}
