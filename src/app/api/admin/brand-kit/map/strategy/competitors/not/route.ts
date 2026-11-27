import { joinedAdmin, notCompetitorFromRequest } from "@/lib/brandStrategy/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Not a competitor (STRATEGY_COMPETITORS_ENABLED), from the Strategy tab or Brand › Competitors. Admins only. */
export async function POST(req: Request) {
  const g = await joinedAdmin(req);
  if (!g.ok) return g.response;
  return notCompetitorFromRequest(g.ctx, await req.json().catch(() => null));
}
