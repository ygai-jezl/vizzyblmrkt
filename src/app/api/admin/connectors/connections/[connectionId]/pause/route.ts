import { NextResponse } from "next/server";
import { z } from "zod";
import { integrationsAdmin } from "@/lib/integrations/admin";
import { isConnectorsEnabled } from "@/lib/connectors/flags";
import { humanActor } from "@/lib/connectors/grants";
import { connectorsOff, jsonBody, respond } from "@/lib/connectors/http";
import { setPaused } from "@/lib/connectors/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ paused: z.boolean() }).strict();

/** Pause or resume a connection's calls. Body: { paused: true | false }. Admins only. */
export async function POST(req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  if (!isConnectorsEnabled()) return connectorsOff();
  const gate = await integrationsAdmin(req, { adminOnly: true });
  if (!gate.ok) return gate.response;
  const parsed = Body.safeParse(await jsonBody(req));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const { connectionId } = await params;
  return respond(await setPaused(gate.ctx, humanActor(gate.ctx), connectionId, parsed.data.paused));
}
