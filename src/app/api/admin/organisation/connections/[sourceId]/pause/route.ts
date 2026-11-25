import { NextResponse } from "next/server";
import { z } from "zod";
import { integrationsAdmin } from "@/lib/integrations/admin";
import { isConnectorsSharingEnabled } from "@/lib/connectors/flags";
import { jsonBody, respond } from "@/lib/connectors/http";
import { setOrganisationPaused } from "@/lib/connectors/organisationConnect";
import { organisationOwner, sharingOff } from "@/lib/connectors/organisationHttp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PauseBodySchema = z.object({ paused: z.boolean() }).strict();

/**
 * Pause or resume one of the organisation's connections, for every brand it serves: no provider
 * call and no collecting while paused; numbers already collected stay readable. Body: { paused }.
 * Any owner.
 */
export async function POST(req: Request, { params }: { params: Promise<{ sourceId: string }> }) {
  if (!isConnectorsSharingEnabled()) return sharingOff();
  const gate = await integrationsAdmin(req, { adminOnly: true, withHome: true });
  if (!gate.ok) return gate.response;
  const o = await organisationOwner(gate);
  if (!o.ok) return o.response;
  const parsed = PauseBodySchema.safeParse(await jsonBody(req));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400, headers: { "cache-control": "no-store" } });
  const { sourceId } = await params;
  return respond(await setOrganisationPaused(o.owner, sourceId, parsed.data.paused));
}
