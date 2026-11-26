import { approveFromRequest, planAdmin } from "@/lib/contentStrategy/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Approve plan: the draft becomes what Next up, the autopilot and Vizzy read. Admins only. */
export async function POST(req: Request) {
  const g = await planAdmin(req);
  if (!g.ok) return g.response;
  return approveFromRequest(g.ctx, await req.json().catch(() => null));
}
