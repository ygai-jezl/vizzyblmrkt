import { integrationsAdmin } from "@/lib/integrations/admin";
import { isConnectorsEnabled } from "@/lib/connectors/flags";
import { humanActor } from "@/lib/connectors/grants";
import { connectorsOff, respond } from "@/lib/connectors/http";
import { checkAccess } from "@/lib/connectors/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Check access for a shared connection: whether its Google address can see the property yet, with
 * the sites or properties it sees for the picker. Retries while Google sets up a new address.
 * Admins only.
 */
export async function POST(req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  if (!isConnectorsEnabled()) return connectorsOff();
  const gate = await integrationsAdmin(req, { adminOnly: true });
  if (!gate.ok) return gate.response;
  const { connectionId } = await params;
  return respond(await checkAccess(gate.ctx, humanActor(gate.ctx), connectionId));
}
