import { createFromRequest, listFromRequest, notesAdmin, notesReader } from "@/lib/brandNotes/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Brand › What we've seen: the brand's notes and what they cover (members read), and adding one (admins). */
export async function GET(req: Request) {
  const g = await notesReader(req);
  if (!g.ok) return g.response;
  return listFromRequest(g.ctx);
}

export async function POST(req: Request) {
  const g = await notesAdmin(req);
  if (!g.ok) return g.response;
  return createFromRequest(g.ctx, await req.json().catch(() => null));
}
