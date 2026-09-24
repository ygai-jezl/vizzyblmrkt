import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import type { AdminGate } from "@/lib/connect/admin";
import { isInvitesEnabled } from "./flags";

/**
 * Gate for the invite admin APIs: the invites flag, the same-origin guard, an
 * admin session, and the admin role for anything that changes state (members
 * can look, not send). Mirrors lifecycleAdmin.
 */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function invitesAdmin(req: Request, opts: { mutate: boolean }): Promise<AdminGate> {
  if (!isInvitesEnabled()) return { ok: false, response: json(503, { error: "invites_disabled" }) };
  const blocked = sameOriginGuard(req);
  if (blocked) return { ok: false, response: blocked };
  const ctx = await getAdminContext();
  if (!ctx) return { ok: false, response: json(401, { error: "unauthorized" }) };
  if (opts.mutate && ctx.role !== "admin") return { ok: false, response: json(403, { error: "forbidden" }) };
  return { ok: true, ctx };
}
