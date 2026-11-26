import { getAdminContext } from "@/lib/auth/session";
import type { AdminGate } from "@/lib/connect/admin";
import { isCanvasAuthConfigured, tenantContextFromCanvasToken, verifyCanvasContext } from "@/lib/canvas/auth";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { isNavV2Phase3Enabled } from "@/lib/nav/flags";
import { isRateLimited, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { isPasteEnabled, isVizzyPasteEnabled } from "./flags";

/**
 * The gates for Paste a list (RAISE_PASTE_ENABLED), in the order of the People gates
 * (switchedAdmin in src/lib/audience/admin.ts): the switch (off = the routes don't exist), the
 * same origin, a session, then the admin role, since adding people is for admins only (decision
 * 28). No per-brand gate: there is no AI and no paid call, and the plan's people allowance warns
 * and never blocks. The brand is always the session's, never the body's, the query's or a header's.
 */

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

async function adminOnly(on: boolean, req: Request): Promise<AdminGate> {
  if (!on) return { ok: false, response: json(404, { error: "not_found" }) };
  const blocked = sameOriginGuard(req);
  if (blocked) return { ok: false, response: blocked };
  const ctx = await getAdminContext();
  if (!ctx) return { ok: false, response: json(401, { error: "unauthorized" }) };
  if (ctx.role !== "admin" || !ctx.userId || ctx.userId.includes("@")) return { ok: false, response: json(403, { error: "forbidden" }) };
  return { ok: true, ctx };
}

/** The paste routes: the switch with People on screen (nav phase 3), then an admin. */
export function pasteAdmin(req: Request): Promise<AdminGate> {
  return adminOnly(isPasteEnabled() && isNavV2Phase3Enabled(), req);
}

/** Remove company: the switch, then an admin. */
export function removeCompanyAdmin(req: Request): Promise<AdminGate> {
  return adminOnly(isPasteEnabled(), req);
}

/** The most a paste request's body may hold, in bytes: the text's 200,000 characters and room for JSON. */
export const PASTE_BODY_BYTES = 262_144;

/**
 * A paste request's JSON body, refused as `too_long` before it is read when it says it is over the
 * cap, and again once read. The text is read here and never logged.
 */
export async function pasteBody(req: Request): Promise<{ ok: true; body: unknown } | { ok: false; error: "too_long" | "invalid_input" }> {
  const said = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(said) && said > PASTE_BODY_BYTES) return { ok: false, error: "too_long" };
  const raw = await req.text().catch(() => null);
  if (raw === null) return { ok: false, error: "invalid_input" };
  if (raw.length > PASTE_BODY_BYTES) return { ok: false, error: "too_long" };
  try {
    return { ok: true, body: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, error: "invalid_input" };
  }
}

/** Vizzy's paste_list_propose: 5 a minute and 30 an hour per brand. */
const AGENT_LIMIT = { prefix: "paste_agent", burstLimit: 5, hourlyLimit: 30 };

export type AgentGate = { ok: true; ctx: TenantContext } | { ok: false; status: number; body: { error: string } };

/**
 * The gate for Vizzy's tool (/api/agent/audience/paste), as viewsAgentGate and authorNewPerson
 * have it: the switch (pasting into the chat also needs AUDIENCE_VIZZY_ADD_PERSON_ENABLED), the
 * signed canvas token, which names the brand and the member asking, the admin role, then the
 * brand's rate limit.
 */
export async function pasteAgentGate(req: Request, db?: FirestoreLike): Promise<AgentGate> {
  if (!isVizzyPasteEnabled()) return { ok: false, status: 503, body: { error: "unavailable" } };
  if (!isCanvasAuthConfigured()) return { ok: false, status: 503, body: { error: "canvas_auth_unconfigured" } };
  const verified = verifyCanvasContext(req.headers.get("x-canvas-context") ?? "");
  if (!verified.ok) return { ok: false, status: 401, body: { error: "unauthorized" } };
  const ctx = tenantContextFromCanvasToken(verified.claims);
  if (ctx.role !== "admin") return { ok: false, status: 403, body: { error: "forbidden" } };
  if (await isRateLimited(`tenant:${ctx.tenantId}`, AGENT_LIMIT, { db })) return { ok: false, status: 429, body: { error: "rate_limited" } };
  return { ok: true, ctx };
}
