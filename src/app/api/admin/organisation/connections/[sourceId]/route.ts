import { integrationsAdmin } from "@/lib/integrations/admin";
import { isConnectorsSharingEnabled } from "@/lib/connectors/flags";
import { respond } from "@/lib/connectors/http";
import { disconnectForOrganisation, sharedConnectionFor } from "@/lib/connectors/organisationConnect";
import { organisationOwner, sharingOff } from "@/lib/connectors/organisationHttp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ sourceId: string }> };

/**
 * One of the organisation's connections, found by id in each provisioned region on the server and
 * refused unless it is this organisation's. Owners only.
 */
export async function GET(req: Request, { params }: Params) {
  if (!isConnectorsSharingEnabled()) return sharingOff();
  const gate = await integrationsAdmin(req, { adminOnly: true, withHome: true });
  if (!gate.ok) return gate.response;
  const o = await organisationOwner(gate);
  if (!o.ok) return o.response;
  const { sourceId } = await params;
  return respond(await sharedConnectionFor(o.owner, sourceId));
}

/**
 * Disconnect it for the organisation: every brand stops reading at once and what each collected is
 * erased in its own region, its Google address is deleted, and a Google sign in is revoked only
 * with CONNECTOR_GOOGLE_REVOKE_ENABLED. Any owner.
 */
export async function DELETE(req: Request, { params }: Params) {
  if (!isConnectorsSharingEnabled()) return sharingOff();
  const gate = await integrationsAdmin(req, { adminOnly: true, withHome: true });
  if (!gate.ok) return gate.response;
  const o = await organisationOwner(gate);
  if (!o.ok) return o.response;
  const { sourceId } = await params;
  return respond(await disconnectForOrganisation(o.owner, sourceId));
}
