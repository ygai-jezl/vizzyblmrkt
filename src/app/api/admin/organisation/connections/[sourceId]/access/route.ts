import { integrationsAdmin } from "@/lib/integrations/admin";
import { isConnectorsSharingEnabled } from "@/lib/connectors/flags";
import { respond } from "@/lib/connectors/http";
import { checkOrganisationAccess } from "@/lib/connectors/organisationConnect";
import { organisationOwner, sharingOff } from "@/lib/connectors/organisationHttp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Check access for the organisation's Google address: whether it sees a site or property yet. Any owner. */
export async function POST(req: Request, { params }: { params: Promise<{ sourceId: string }> }) {
  if (!isConnectorsSharingEnabled()) return sharingOff();
  const gate = await integrationsAdmin(req, { adminOnly: true, withHome: true });
  if (!gate.ok) return gate.response;
  const o = await organisationOwner(gate);
  if (!o.ok) return o.response;
  const { sourceId } = await params;
  return respond(await checkOrganisationAccess(o.owner, sourceId));
}
