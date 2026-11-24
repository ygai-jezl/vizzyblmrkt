import { integrationsAdmin } from "@/lib/integrations/admin";
import { isConnectorsEnabled } from "@/lib/connectors/flags";
import { humanActor } from "@/lib/connectors/grants";
import { connectorsOff, respond } from "@/lib/connectors/http";
import { check } from "@/lib/connectors/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Check now: run the connector's verify request and record the outcome. Admins only. */
export async function POST(req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  if (!isConnectorsEnabled()) return connectorsOff();
  const gate = await integrationsAdmin(req, { adminOnly: true });
  if (!gate.ok) return gate.response;
  const { connectionId } = await params;
  return respond(await check(gate.ctx, humanActor(gate.ctx), connectionId));
}
