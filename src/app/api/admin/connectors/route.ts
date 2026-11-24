import { integrationsAdmin } from "@/lib/integrations/admin";
import { isConnectorsEnabled } from "@/lib/connectors/flags";
import { humanActor } from "@/lib/connectors/grants";
import { connectorsOff, respond } from "@/lib/connectors/http";
import { listForActor } from "@/lib/connectors/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Browse and the brand's connections (ADR-0011). Members may read: they see each connection's
 * name and health; admins also see its account, owner, grants and recent activity. Secrets never
 * leave the server.
 */
export async function GET(req: Request) {
  if (!isConnectorsEnabled()) return connectorsOff();
  const gate = await integrationsAdmin(req, { adminOnly: false });
  if (!gate.ok) return gate.response;
  return respond(await listForActor(gate.ctx, humanActor(gate.ctx)));
}
