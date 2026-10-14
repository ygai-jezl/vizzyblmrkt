import { brandMapAdmin, saveFromRequest } from "@/lib/brandMap/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Save the brand map (Brand › Brand map). Admin-only. The body names the revision the admin
 * started from; a save over someone else's is refused with the map as it is now (409
 * `map_changed`). Accepted and dismissed suggestions leave the list.
 */
export async function PUT(req: Request) {
  const g = await brandMapAdmin(req);
  if (!g.ok) return g.response;
  return saveFromRequest(g.ctx, await req.json().catch(() => null));
}
