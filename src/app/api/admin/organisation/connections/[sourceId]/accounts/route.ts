import { integrationsAdmin } from "@/lib/integrations/admin";
import { isConnectorsSharingEnabled } from "@/lib/connectors/flags";
import { respond } from "@/lib/connectors/http";
import { organisationOwner, sharingOff } from "@/lib/connectors/organisationHttp";
import { listOrganisationAccounts } from "@/lib/connectors/organisationParts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What the organisation's connection can see now, for giving its parts: each marked when it is
 * given already, and with the organisation's brands that read it with their own connection. For a
 * Google sign in, only the owner who signed in. Nothing is stored.
 */
export async function GET(req: Request, { params }: { params: Promise<{ sourceId: string }> }) {
  if (!isConnectorsSharingEnabled()) return sharingOff();
  const gate = await integrationsAdmin(req, { adminOnly: true, withHome: true });
  if (!gate.ok) return gate.response;
  const o = await organisationOwner(gate);
  if (!o.ok) return o.response;
  const { sourceId } = await params;
  return respond(await listOrganisationAccounts(o.owner, sourceId));
}
