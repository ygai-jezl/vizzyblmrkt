import { lifecycleAdmin, readJson, respond } from "@/lib/connect/admin";
import { fireSandbox } from "@/lib/connect/adminApi";
import { originFromHeaders } from "@/lib/http/origin";
import { platformOrigin } from "@/lib/platform/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Act as the sandbox product: send signed events through the real ingest path. */
export async function POST(req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const gate = await lifecycleAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  const { connectionId } = await params;
  const origin = platformOrigin() || originFromHeaders(req.headers);
  return respond(await fireSandbox(gate.ctx, connectionId, await readJson(req), { origin }));
}
