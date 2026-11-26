import { isNotFromRequest, strategyAdmin } from "@/lib/brandStrategy/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Add a proposed "what you're not" line to Who you are, or say No to it. Admins only. */
export async function POST(req: Request) {
  const g = await strategyAdmin(req);
  if (!g.ok) return g.response;
  return isNotFromRequest(g.ctx, await req.json().catch(() => null));
}
