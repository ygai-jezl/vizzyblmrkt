import type { AdminGate } from "@/lib/connect/admin";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { isRaiseFollowupsEnabled, isRaisePipelineEnabled } from "./flags";

/**
 * Gate for the board's admin APIs, in src/lib/audience/admin.ts's order: the switch (off = the
 * route doesn't exist, 404), same origin, a session (401), then the admin role for any change
 * (403). RAISE_PIPELINE_ENABLED for setup, the board and moves; RAISE_FOLLOWUPS_ENABLED as well for
 * deciding a follow-up. The brand always comes from the session, never from the request.
 */
export async function raiseAdmin(req: Request, opts: { mutate: boolean; followUps?: boolean }): Promise<AdminGate> {
  const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
  const on = opts.followUps ? isRaiseFollowupsEnabled() : isRaisePipelineEnabled();
  if (!on) return { ok: false, response: json(404, { error: "not_found" }) };
  const blocked = sameOriginGuard(req);
  if (blocked) return { ok: false, response: blocked };
  const ctx = await getAdminContext();
  if (!ctx) return { ok: false, response: json(401, { error: "unauthorized" }) };
  if (opts.mutate && ctx.role !== "admin") return { ok: false, response: json(403, { error: "forbidden" }) };
  return { ok: true, ctx };
}
