import { respond } from "@/lib/connect/admin";
import { invitesAdmin } from "@/lib/invites/admin";
import { connectionInvites } from "@/lib/invites/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** For Products › Setup: the product's sign-up link and its invite numbers. */
export async function GET(req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const gate = await invitesAdmin(req, { mutate: false });
  if (!gate.ok) return gate.response;
  const { connectionId } = await params;
  return respond(await connectionInvites(gate.ctx, connectionId));
}
