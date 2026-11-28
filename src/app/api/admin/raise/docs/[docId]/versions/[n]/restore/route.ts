import { raiseAdmin, restoreFromRequest } from "@/lib/raise/docs/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Put a kept version back, as a new version. Admins. */
export async function POST(req: Request, { params }: { params: Promise<{ docId: string; n: string }> }) {
  const g = await raiseAdmin(req);
  if (!g.ok) return g.response;
  const { docId, n } = await params;
  return restoreFromRequest(g.ctx, docId, n, await req.json().catch(() => null));
}
