import { lifecycleAdmin, respond } from "@/lib/connect/admin";
import { rotateProductConnectionSecret } from "@/lib/connect/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Issue a new secret (shown once); the old one keeps working for 24 hours. */
export async function POST(req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const gate = await lifecycleAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  const { connectionId } = await params;
  return respond(await rotateProductConnectionSecret(gate.ctx, connectionId));
}
