import { createFromRequest, listFromRequest, notesAdmin, notesReader } from "@/lib/brandNotes/api";
import { keptFromTokens } from "@/lib/loops/handBack";
import { tokensFromRequest } from "@/lib/loops/stampHeader";

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
  const res = await createFromRequest(g.ctx, await req.json().catch(() => null));
  // The first note added from Vizzy's split brings its stamp: checked here and counted kept, a
  // refused token counted (learning loops step 5, decision 20). Off, or a note a person wrote,
  // nothing is read.
  if (res.ok) await keptFromTokens(g.ctx, ["brand_notes"], tokensFromRequest(req));
  return res;
}
