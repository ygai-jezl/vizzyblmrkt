import { approveFromRequest, strategyAdmin } from "@/lib/brandStrategy/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Approve strategy: the draft becomes what the writer, research, Next up and Vizzy read. Admins only. */
export async function POST(req: Request) {
  const g = await strategyAdmin(req);
  if (!g.ok) return g.response;
  return approveFromRequest(g.ctx, await req.json().catch(() => null));
}
