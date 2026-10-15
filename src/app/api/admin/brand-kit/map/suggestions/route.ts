import { brandMapAdmin, dismissFromRequest } from "@/lib/brandMap/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Dismiss brand map suggestions by key (Brand › Brand map). Admin-only, and at once: a
 * dismissal changes nothing decided, so it needs no save, and the same suggestion is never
 * filed again.
 */
export async function DELETE(req: Request) {
  const g = await brandMapAdmin(req);
  if (!g.ok) return g.response;
  return dismissFromRequest(g.ctx, await req.json().catch(() => null));
}
