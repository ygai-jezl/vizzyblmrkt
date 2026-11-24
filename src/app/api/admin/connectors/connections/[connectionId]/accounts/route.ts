import { integrationsAdmin } from "@/lib/integrations/admin";
import { isConnectorsEnabled } from "@/lib/connectors/flags";
import { humanActor } from "@/lib/connectors/grants";
import { connectorsOff, jsonBody, respond } from "@/lib/connectors/http";
import { listAccounts, pickAccount } from "@/lib/connectors/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ connectionId: string }> };

/**
 * The sites or properties a signed in connection can see, for the picker: Search Console's
 * sites.list with unverified sites left out. Admins only; nothing is stored.
 */
export async function GET(req: Request, { params }: Params) {
  if (!isConnectorsEnabled()) return connectorsOff();
  const gate = await integrationsAdmin(req, { adminOnly: true });
  if (!gate.ok) return gate.response;
  const { connectionId } = await params;
  return respond(await listAccounts(gate.ctx, humanActor(gate.ctx), connectionId));
}

/**
 * Pick which one the connection reads. It must be in the list the sign in sees now, and not read
 * by another of the brand's connections. Admins only. Body: { account }.
 */
export async function PUT(req: Request, { params }: Params) {
  if (!isConnectorsEnabled()) return connectorsOff();
  const gate = await integrationsAdmin(req, { adminOnly: true });
  if (!gate.ok) return gate.response;
  const { connectionId } = await params;
  return respond(await pickAccount(gate.ctx, humanActor(gate.ctx), connectionId, await jsonBody(req)));
}
