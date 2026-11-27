import { getAdminContext } from "@/lib/auth/session";
import type { AdminGate } from "@/lib/connect/admin";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { fail } from "@/lib/onboarding/api";
import { isNextActionCardEnabled } from "./flags";

/**
 * The gate for Your next action's APIs (/api/admin/next-action/**): the origin, the switch, sign-in
 * and admin, in that order. The card is written from what admins kept about the business, so
 * members get 403 here and see Home's steps list.
 */
export async function nextActionAdmin(req: Request): Promise<AdminGate> {
  const blocked = sameOriginGuard(req);
  if (blocked) return { ok: false, response: blocked };
  if (!isNextActionCardEnabled()) return { ok: false, response: fail(503, "next_action_disabled") };
  const ctx = await getAdminContext();
  if (!ctx) return { ok: false, response: fail(401, "unauthorized") };
  if (ctx.role !== "admin") return { ok: false, response: fail(403, "forbidden") };
  return { ok: true, ctx };
}
