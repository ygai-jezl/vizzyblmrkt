import { integrationsAdmin } from "@/lib/integrations/admin";
import { isConnectorsEnabled } from "@/lib/connectors/flags";
import { humanActor } from "@/lib/connectors/grants";
import { connectorsOff, jsonBody, respond } from "@/lib/connectors/http";
import { shareConnect } from "@/lib/connectors/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Start share access for a connector (Search Console, Google Analytics): make the connection's own
 * Google address and answer it with the role to give it and where. Admins only. A brand with a
 * shared connection still waiting for its property gets that one back. Body: { label? }.
 */
export async function POST(req: Request, { params }: { params: Promise<{ connectorId: string }> }) {
  if (!isConnectorsEnabled()) return connectorsOff();
  const gate = await integrationsAdmin(req, { adminOnly: true });
  if (!gate.ok) return gate.response;
  const { connectorId } = await params;
  return respond(await shareConnect(gate.ctx, humanActor(gate.ctx), connectorId, await jsonBody(req)));
}
