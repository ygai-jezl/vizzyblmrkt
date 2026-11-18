import { competitorsAdmin, competitorsReader } from "@/lib/competitors/api";
import { subjectFlagsFromRequest, suggestTopicsFromRequest } from "@/lib/competitors/planningApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How much competitors wrote on each brand map subject, for the subject list (members and admins). */
export async function GET(req: Request) {
  const g = await competitorsReader(req);
  if (!g.ok) return g.response;
  return subjectFlagsFromRequest(g.ctx);
}

/** Suggest subjects competitors write about, and the brand map lacks, for the map (admins). */
export async function POST(req: Request) {
  const g = await competitorsAdmin(req);
  if (!g.ok) return g.response;
  return suggestTopicsFromRequest(g.ctx, await req.json().catch(() => ({})));
}
