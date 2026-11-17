import { competitorsAdmin, competitorsReader, listFromRequest, monitorFromRequest } from "@/lib/competitors/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Brand › Competitors: the competitors a brand watches (members read), and Monitor (admins). */
export async function GET(req: Request) {
  const g = await competitorsReader(req);
  if (!g.ok) return g.response;
  return listFromRequest(g.ctx);
}

export async function POST(req: Request) {
  const g = await competitorsAdmin(req);
  if (!g.ok) return g.response;
  return monitorFromRequest(g.ctx, await req.json().catch(() => null));
}
