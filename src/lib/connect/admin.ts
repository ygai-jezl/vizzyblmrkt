import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { isLifecycleEnabled } from "@/lib/lifecycle/flags";
import type { TenantContext } from "@/lib/tenant";

/**
 * Shared gate for the Products (connection) admin APIs: the feature flag, the
 * same-origin guard, an admin session, and — for anything that changes state —
 * the admin role (members can look, not touch). Mirrors the inline checks in
 * the other admin routes.
 */
export type AdminGate = { ok: true; ctx: TenantContext } | { ok: false; response: Response };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function lifecycleAdmin(req: Request, opts: { mutate: boolean }): Promise<AdminGate> {
  if (!isLifecycleEnabled()) return { ok: false, response: json(503, { error: "lifecycle_disabled" }) };
  const blocked = sameOriginGuard(req);
  if (blocked) return { ok: false, response: blocked };
  const ctx = await getAdminContext();
  if (!ctx) return { ok: false, response: json(401, { error: "unauthorized" }) };
  if (opts.mutate && ctx.role !== "admin") return { ok: false, response: json(403, { error: "forbidden" }) };
  return { ok: true, ctx };
}

/** The request body as JSON, or undefined when it isn't valid JSON. */
export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

/** Turn an admin-API result into a response. */
export function respond(result: { status: number; body: unknown }): Response {
  return json(result.status, result.body);
}
