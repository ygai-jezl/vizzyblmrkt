import { competitorsReader } from "@/lib/competitors/api";
import { subjectCompetitorsFromRequest } from "@/lib/competitors/planningApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What competitors wrote on one brand map subject, for its panel. */
export async function GET(req: Request, { params }: { params: Promise<{ subjectId: string }> }) {
  const g = await competitorsReader(req);
  if (!g.ok) return g.response;
  return subjectCompetitorsFromRequest(g.ctx, (await params).subjectId);
}
