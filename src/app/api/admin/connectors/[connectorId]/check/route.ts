import { integrationsAdmin } from "@/lib/integrations/admin";
import { isConnectorsEnabled } from "@/lib/connectors/flags";
import { humanActor } from "@/lib/connectors/grants";
import { connectorsOff, jsonBody, respond } from "@/lib/connectors/http";
import { checkToken } from "@/lib/connectors/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Check a pasted token before connecting, and list what it can see for the picker (Cloudflare's
 * zones), or say it can't list them, so the account is typed. Admins only, behind the same switch
 * and gate as connect, and rate limited. Nothing is saved, and the token is never logged or sent
 * back. Body: { fields: { token } }.
 */
export async function POST(req: Request, { params }: { params: Promise<{ connectorId: string }> }) {
  if (!isConnectorsEnabled()) return connectorsOff();
  const gate = await integrationsAdmin(req, { adminOnly: true });
  if (!gate.ok) return gate.response;
  const { connectorId } = await params;
  return respond(await checkToken(gate.ctx, humanActor(gate.ctx), connectorId, await jsonBody(req)));
}
