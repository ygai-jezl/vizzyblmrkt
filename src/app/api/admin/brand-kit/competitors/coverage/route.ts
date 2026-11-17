import { competitorsAdmin } from "@/lib/competitors/api";
import { suggestTopicsFromRequest } from "@/lib/competitors/planningApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Suggest subjects competitors write about, and the brand map lacks, for the map (admins). */
export async function POST(req: Request) {
  const g = await competitorsAdmin(req);
  if (!g.ok) return g.response;
  return suggestTopicsFromRequest(g.ctx, await req.json().catch(() => ({})));
}
