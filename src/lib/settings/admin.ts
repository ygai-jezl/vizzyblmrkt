import { getAdminContext } from "@/lib/auth/session";
import type { AdminGate } from "@/lib/connect/admin";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { isSettingsHistoryEnabled } from "./flags";

/**
 * Gate for Settings › History's routes (SETTINGS_HISTORY_ENABLED), checked in this order: the
 * switch (off = the routes don't exist), same origin, a session, then the admin role for a restore.
 * Anyone on the team reads and exports. The brand is the session's, never the request's.
 */
export async function historyAdmin(req: Request, opts: { mutate: boolean }): Promise<AdminGate> {
  const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
  if (!isSettingsHistoryEnabled()) return { ok: false, response: json(404, { error: "not_found" }) };
  const blocked = sameOriginGuard(req);
  if (blocked) return { ok: false, response: blocked };
  const ctx = await getAdminContext();
  if (!ctx) return { ok: false, response: json(401, { error: "unauthorized" }) };
  if (opts.mutate && ctx.role !== "admin") return { ok: false, response: json(403, { error: "forbidden" }) };
  return { ok: true, ctx };
}
