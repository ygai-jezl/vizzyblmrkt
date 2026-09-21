import { lifecycleAdmin, readJson, respond } from "@/lib/connect/admin";
import { testContext } from "@/lib/connect/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** "Test connection": pull context for one user and return the validated payload. */
export async function POST(req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const gate = await lifecycleAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  const { connectionId } = await params;
  return respond(await testContext(gate.ctx, connectionId, await readJson(req)));
}
