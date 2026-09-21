import { lifecycleAdmin, respond } from "@/lib/connect/admin";
import { listConnectionUsers } from "@/lib/connect/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The product's end users, most recently seen first (cursor = `after`). */
export async function GET(req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const gate = await lifecycleAdmin(req, { mutate: false });
  if (!gate.ok) return gate.response;
  const { connectionId } = await params;
  const q = new URL(req.url).searchParams;
  const limit = Number(q.get("limit") ?? "50") || 50;
  return respond(await listConnectionUsers(gate.ctx, connectionId, { limit, after: q.get("after") }));
}
