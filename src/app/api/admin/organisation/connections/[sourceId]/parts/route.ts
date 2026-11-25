import { integrationsAdmin } from "@/lib/integrations/admin";
import { isConnectorsSharingEnabled } from "@/lib/connectors/flags";
import { jsonBody, respond } from "@/lib/connectors/http";
import { organisationOwner, sharingOff } from "@/lib/connectors/organisationHttp";
import { changePartOf, givePartTo, takeBackPart } from "@/lib/connectors/organisationParts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ sourceId: string }> };

/**
 * Give a brand a part: { tenantId, account, label?, members, vizzy }. The owner must be an admin
 * of that brand, read live, and for a Google sign in the one who signed in. The brand's region
 * comes from its own record, never from the request.
 */
export async function POST(req: Request, { params }: Params) {
  if (!isConnectorsSharingEnabled()) return sharingOff();
  const gate = await integrationsAdmin(req, { adminOnly: true, withHome: true });
  if (!gate.ok) return gate.response;
  const o = await organisationOwner(gate);
  if (!o.ok) return o.response;
  const { sourceId } = await params;
  return respond(await givePartTo(o.owner, sourceId, await jsonBody(req)));
}

/** Change a brand's part: { tenantId, account, label? }, with the same checks as giving one. */
export async function PUT(req: Request, { params }: Params) {
  if (!isConnectorsSharingEnabled()) return sharingOff();
  const gate = await integrationsAdmin(req, { adminOnly: true, withHome: true });
  if (!gate.ok) return gate.response;
  const o = await organisationOwner(gate);
  if (!o.ok) return o.response;
  const { sourceId } = await params;
  return respond(await changePartOf(o.owner, sourceId, await jsonBody(req)));
}

/** Take a brand's part back: { tenantId }. Any owner. */
export async function DELETE(req: Request, { params }: Params) {
  if (!isConnectorsSharingEnabled()) return sharingOff();
  const gate = await integrationsAdmin(req, { adminOnly: true, withHome: true });
  if (!gate.ok) return gate.response;
  const o = await organisationOwner(gate);
  if (!o.ok) return o.response;
  const { sourceId } = await params;
  return respond(await takeBackPart(o.owner, sourceId, await jsonBody(req)));
}
