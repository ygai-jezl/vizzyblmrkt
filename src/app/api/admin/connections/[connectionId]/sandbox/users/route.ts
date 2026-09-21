import { lifecycleAdmin, readJson, respond } from "@/lib/connect/admin";
import { putSandboxUsers } from "@/lib/connect/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Replace the sandbox's test users (addresses: yours, or a verified domain). */
export async function PUT(req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const gate = await lifecycleAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  const { connectionId } = await params;
  return respond(await putSandboxUsers(gate.ctx, connectionId, await readJson(req)));
}
