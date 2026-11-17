import {
  actionFromRequest,
  competitorsAdmin,
  competitorsReader,
  detailFromRequest,
  removeFromRequest,
  updateFromRequest,
} from "@/lib/competitors/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ competitorId: string }> };

/** One competitor: what we know and what changed (members read). */
export async function GET(req: Request, { params }: Params) {
  const g = await competitorsReader(req);
  if (!g.ok) return g.response;
  return detailFromRequest(g.ctx, (await params).competitorId);
}

/** Rename it, choose its news page or sitemap, pause or resume (admins). */
export async function PATCH(req: Request, { params }: Params) {
  const g = await competitorsAdmin(req);
  if (!g.ok) return g.response;
  return updateFromRequest(g.ctx, (await params).competitorId, await req.json().catch(() => null));
}

/** Carry on with setup, check now, try again, or put its name on the brand map (admins). */
export async function POST(req: Request, { params }: Params) {
  const g = await competitorsAdmin(req);
  if (!g.ok) return g.response;
  return actionFromRequest(g.ctx, (await params).competitorId, await req.json().catch(() => null));
}

/** Stop watching: everything read about it goes; its brand map name stays (admins). */
export async function DELETE(req: Request, { params }: Params) {
  const g = await competitorsAdmin(req);
  if (!g.ok) return g.response;
  return removeFromRequest(g.ctx, (await params).competitorId);
}
