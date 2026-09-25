import { lifecycleAdmin, readJson, respond } from "@/lib/connect/admin";
import { fireSandbox } from "@/lib/connect/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Act as the sandbox product: send a test user's state through the real API v2 write path. */
export async function POST(req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const gate = await lifecycleAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  const { connectionId } = await params;
  return respond(await fireSandbox(gate.ctx, connectionId, await readJson(req)));
}
