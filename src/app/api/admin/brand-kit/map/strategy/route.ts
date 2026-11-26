import { deleteFromRequest, saveFromRequest, strategyAdmin, strategyReader, viewFromRequest } from "@/lib/brandStrategy/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Brand › Brand map › Strategy (BRAND_STRATEGY_ENABLED): any member reads it. */
export async function GET(req: Request) {
  const g = await strategyReader(req);
  if (!g.ok) return g.response;
  return viewFromRequest(g.ctx);
}

/** An admin's edit of the draft, naming the revision they started from. */
export async function PUT(req: Request) {
  const g = await strategyAdmin(req);
  if (!g.ok) return g.response;
  return saveFromRequest(g.ctx, await req.json().catch(() => null));
}

/** Start over: an admin removes the strategy, its history and its decisions. */
export async function DELETE(req: Request) {
  const g = await strategyAdmin(req);
  if (!g.ok) return g.response;
  return deleteFromRequest(g.ctx);
}
