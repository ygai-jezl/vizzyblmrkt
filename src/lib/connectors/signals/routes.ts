import { NextResponse } from "next/server";
import { z } from "zod";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { integrationsAdmin } from "@/lib/integrations/admin";
import { DATA_SIGNAL_ID } from "@/lib/types/dataSignal";
import { isConnectorSignalsEnabled } from "../flags";
import { dismissSignal, planFromSignal, SUGGESTION_BUSY, type DecideError } from "./review";

/**
 * The two Review decisions on a suggestion from collected numbers (CONNECTOR_SIGNALS_ENABLED):
 * POST /api/admin/data-signals/<signalId>/approve (Plan an article) and .../dismiss. In order: the
 * origin check, the switch (404 while off, as the connector routes answer), sign in and the admin
 * role (integrationsAdmin), then the id (`dsg_` and 24 hex) and the body. The brand is the
 * session's, never the request's.
 */

const PlanBody = z.object({ workspaceId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional() }).strict();

const STATUS: Record<DecideError, number> = { not_found: 404, changed: 409, no_programme: 409, busy: 503 };
const MESSAGE: Record<DecideError, string> = {
  not_found: "That suggestion isn't there any more.",
  changed: "That suggestion was decided already. Refresh Review to see what is waiting.",
  no_programme: "Choose the programme to write it in, or add one first.",
  busy: SUGGESTION_BUSY,
};
const fail = (e: DecideError) => NextResponse.json({ error: e, message: MESSAGE[e] }, { status: STATUS[e], headers: { "cache-control": "no-store" } });

type Gate = { ok: true; ctx: Parameters<typeof planFromSignal>[0] } | { ok: false; response: Response };

async function gate(req: Request, signalId: string): Promise<Gate> {
  const blocked = sameOriginGuard(req);
  if (blocked) return { ok: false, response: blocked };
  if (!isConnectorSignalsEnabled()) return { ok: false, response: NextResponse.json({ error: "not_found" }, { status: 404 }) };
  const admin = await integrationsAdmin(req, { adminOnly: true });
  if (!admin.ok) return { ok: false, response: admin.response };
  if (!DATA_SIGNAL_ID.test(signalId)) return { ok: false, response: NextResponse.json({ error: "invalid_input" }, { status: 400 }) };
  return { ok: true, ctx: admin.ctx };
}

export async function approveRoute(req: Request, signalId: string): Promise<Response> {
  const g = await gate(req, signalId);
  if (!g.ok) return g.response;
  const text = await req.text().catch(() => "");
  let raw: unknown = {};
  try {
    raw = text.trim() ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  const body = PlanBody.safeParse(raw);
  if (!body.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const r = await planFromSignal(g.ctx, signalId, body.data);
  return r.ok ? NextResponse.json({ ok: true, href: r.value.href }, { headers: { "cache-control": "no-store" } }) : fail(r.error);
}

export async function dismissRoute(req: Request, signalId: string): Promise<Response> {
  const g = await gate(req, signalId);
  if (!g.ok) return g.response;
  const r = await dismissSignal(g.ctx, signalId);
  return r.ok ? NextResponse.json({ ok: true, dismissedUntil: r.value.dismissedUntil }, { headers: { "cache-control": "no-store" } }) : fail(r.error);
}
