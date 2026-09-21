import { lifecycleAdmin, respond } from "@/lib/connect/admin";
import { eraseConnectionUser } from "@/lib/connect/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ connectionId: string; userId: string }> };

/** Erase one product user (GDPR Art. 17): tombstone + event history deleted. */
export async function DELETE(req: Request, { params }: Params) {
  const gate = await lifecycleAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  const { connectionId, userId } = await params;
  return respond(await eraseConnectionUser(gate.ctx, connectionId, userId));
}
