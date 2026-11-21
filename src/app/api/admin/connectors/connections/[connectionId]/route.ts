import { integrationsAdmin } from "@/lib/integrations/admin";
import { isConnectorsEnabled } from "@/lib/connectors/flags";
import { humanActor } from "@/lib/connectors/grants";
import { connectorsOff, respond } from "@/lib/connectors/http";
import { disconnect, getForActor } from "@/lib/connectors/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ connectionId: string }> };

/** One connection: name and health for members, everything but its secrets for admins. */
export async function GET(req: Request, { params }: Params) {
  if (!isConnectorsEnabled()) return connectorsOff();
  const gate = await integrationsAdmin(req, { adminOnly: false });
  if (!gate.ok) return gate.response;
  const { connectionId } = await params;
  return respond(await getForActor(gate.ctx, humanActor(gate.ctx), connectionId));
}

/**
 * Disconnect: delete the stored secrets and mark the connection disconnected. Admins only. A
 * pasted token can't be cancelled from here, so the answer says what to do at the provider.
 */
export async function DELETE(req: Request, { params }: Params) {
  if (!isConnectorsEnabled()) return connectorsOff();
  const gate = await integrationsAdmin(req, { adminOnly: true });
  if (!gate.ok) return gate.response;
  const { connectionId } = await params;
  return respond(await disconnect(gate.ctx, humanActor(gate.ctx), connectionId));
}
