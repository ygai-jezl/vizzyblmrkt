import { raiseAdmin, refreshFromRequest } from "@/lib/raise/docs/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Refresh numbers: YouGrow's numbers filled again, as a new version when any moved. Admins. */
export async function POST(req: Request, { params }: { params: Promise<{ docId: string }> }) {
  const g = await raiseAdmin(req);
  if (!g.ok) return g.response;
  return refreshFromRequest(g.ctx, (await params).docId, await req.json().catch(() => null));
}
