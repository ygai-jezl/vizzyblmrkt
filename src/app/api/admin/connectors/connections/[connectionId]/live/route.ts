import { integrationsAdmin } from "@/lib/integrations/admin";
import { isConnectorsEnabled } from "@/lib/connectors/flags";
import { humanActor } from "@/lib/connectors/grants";
import { connectorsOff, respond } from "@/lib/connectors/http";
import { readLiveFor } from "@/lib/connectors/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A live read of a connection's numbers, each with its meaning. Admins, and members when the
 * connection grants members read. Query: stream, from, to (YYYY-MM-DD, UTC), by, limit; at most
 * 93 days and 100 rows.
 */
export async function GET(req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  if (!isConnectorsEnabled()) return connectorsOff();
  const gate = await integrationsAdmin(req, { adminOnly: false });
  if (!gate.ok) return gate.response;
  const { connectionId } = await params;
  const query = Object.fromEntries(new URL(req.url).searchParams);
  return respond(await readLiveFor(gate.ctx, humanActor(gate.ctx), connectionId, query));
}
