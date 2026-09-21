import { lifecycleAdmin, respond } from "@/lib/connect/admin";
import { listConnectionEvents } from "@/lib/connect/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Event debugger: the latest accepted events plus recent rejections. */
export async function GET(req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const gate = await lifecycleAdmin(req, { mutate: false });
  if (!gate.ok) return gate.response;
  const { connectionId } = await params;
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? "50") || 50;
  return respond(await listConnectionEvents(gate.ctx, connectionId, { limit }));
}
