import { competitorsAdmin, seenFromRequest } from "@/lib/competitors/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Mark what changed as seen: one competitor's (`competitorId`), or all of them (admins). */
export async function POST(req: Request) {
  const g = await competitorsAdmin(req);
  if (!g.ok) return g.response;
  return seenFromRequest(g.ctx, await req.json().catch(() => ({})));
}
