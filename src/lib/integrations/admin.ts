import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import type { AdminGate } from "@/lib/connect/admin";
import type { TenantContext } from "@/lib/tenant";

/**
 * The one gate for every route under /api/admin/integrations: connecting, disconnecting
 * and picking repos for GitHub, GitLab, X, LinkedIn and LinkedIn Pages.
 *
 * Order: origin check, sign-in, then the admin role for anything that changes state.
 * Members can see which accounts are connected, but only admins change them.
 * src/lib/integrations/routesGate.test.ts fails when a route skips this file.
 */
export async function integrationsAdmin(req: Request, opts: { adminOnly: boolean }): Promise<AdminGate> {
  const blocked = sameOriginGuard(req);
  if (blocked) return { ok: false, response: blocked };
  const ctx = await getAdminContext();
  if (!ctx) return { ok: false, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  if (opts.adminOnly && ctx.role !== "admin") {
    return { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  return { ok: true, ctx };
}

export type HopGate = { ok: true; ctx: TenantContext } | { ok: false; why: "signed_out" | "forbidden" };

/**
 * The gate for the OAuth hops (start and callback). These are top level navigations that
 * come back from the provider's site, so there is no origin check: the signed state and
 * the browser bound nonce cookie do that job. Each route builds its own response, so a
 * start keeps its 401 JSON and a callback keeps its /login redirect.
 */
export async function integrationsHopAdmin(): Promise<HopGate> {
  const ctx = await getAdminContext();
  if (!ctx) return { ok: false, why: "signed_out" };
  if (ctx.role !== "admin") return { ok: false, why: "forbidden" };
  return { ok: true, ctx };
}
