import { exportFromRequest, raiseAdmin } from "@/lib/raise/docs/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Download data: the deck and its kept versions as a JSON file. Admins. */
export async function GET(req: Request, { params }: { params: Promise<{ docId: string }> }) {
  const g = await raiseAdmin(req);
  if (!g.ok) return g.response;
  return exportFromRequest(g.ctx, (await params).docId);
}
