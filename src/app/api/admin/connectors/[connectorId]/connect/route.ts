import { integrationsAdmin } from "@/lib/integrations/admin";
import { isConnectorsEnabled } from "@/lib/connectors/flags";
import { humanActor } from "@/lib/connectors/grants";
import { connectorsOff, jsonBody, respond } from "@/lib/connectors/http";
import { connect } from "@/lib/connectors/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Connect with typed fields (an API token and its account). Admins only. The token is checked
 * with the connector's verify request before anything is saved, then sealed in the vault.
 * Body: { fields: { ... }, label? }.
 */
export async function POST(req: Request, { params }: { params: Promise<{ connectorId: string }> }) {
  if (!isConnectorsEnabled()) return connectorsOff();
  const gate = await integrationsAdmin(req, { adminOnly: true });
  if (!gate.ok) return gate.response;
  const { connectorId } = await params;
  return respond(await connect(gate.ctx, humanActor(gate.ctx), connectorId, await jsonBody(req)));
}
