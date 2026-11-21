import { integrationsAdmin } from "@/lib/integrations/admin";
import { isConnectorsEnabled } from "@/lib/connectors/flags";
import { humanActor } from "@/lib/connectors/grants";
import { connectorsOff, jsonBody, respond } from "@/lib/connectors/http";
import { setGrants } from "@/lib/connectors/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Who beyond admins may read a connection live: members, Vizzy, both or neither.
 * Body: { grants: [{ to: "members" | "agent:vizzy", can: "read" }] }. Admins only.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  if (!isConnectorsEnabled()) return connectorsOff();
  const gate = await integrationsAdmin(req, { adminOnly: true });
  if (!gate.ok) return gate.response;
  const { connectionId } = await params;
  return respond(await setGrants(gate.ctx, humanActor(gate.ctx), connectionId, await jsonBody(req)));
}
