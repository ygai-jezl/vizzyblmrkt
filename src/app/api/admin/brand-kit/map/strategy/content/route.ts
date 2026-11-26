import { deleteFromRequest, editFromRequest, planAdmin, planReader, viewFromRequest } from "@/lib/contentStrategy/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Brand › Brand map › Strategy › Content plan (CONTENT_STRATEGY_ENABLED): any member reads it, or one pillar's slots with `pillar`. */
export async function GET(req: Request) {
  const g = await planReader(req);
  if (!g.ok) return g.response;
  return viewFromRequest(g.ctx, req.url);
}

/** An admin's change to the draft: split or join slots, rename a pillar, skip or move a pick. */
export async function PUT(req: Request) {
  const g = await planAdmin(req);
  if (!g.ok) return g.response;
  return editFromRequest(g.ctx, await req.json().catch(() => null));
}

/** Start over: an admin removes the plan, its history and its decisions. */
export async function DELETE(req: Request) {
  const g = await planAdmin(req);
  if (!g.ok) return g.response;
  return deleteFromRequest(g.ctx);
}
