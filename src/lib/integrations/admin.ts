import { NextResponse } from "next/server";
import { getAdminContext, getAdminContextWithHome } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import type { AdminGate } from "@/lib/connect/admin";
import type { TenantContext } from "@/lib/tenant";
import type { TenantRole } from "@/lib/types/tenantUser";

/**
 * The one gate for every route under /api/admin/integrations: connecting, disconnecting
 * and picking repos for GitHub, GitLab, X, LinkedIn and LinkedIn Pages.
 *
 * Order: origin check, sign-in, then the admin role for anything that changes state.
 * Members can see which accounts are connected, but only admins change them.
 * src/lib/integrations/routesGate.test.ts fails when a route skips this file.
 *
 * `withHome` also answers the person's home brand and its claims' role from the same session
 * check, for the organisation routes (Connectors 3), which ask whether the person is an admin of
 * a brand they reach only as their home brand (isBrandAdminLive in src/lib/tenant).
 */
export type AdminGateWithHome = { ok: true; ctx: TenantContext; home: { tenantId: string; role: TenantRole | undefined } } | { ok: false; response: Response };

export async function integrationsAdmin(req: Request, opts: { adminOnly: boolean; withHome: true }): Promise<AdminGateWithHome>;
export async function integrationsAdmin(req: Request, opts: { adminOnly: boolean; withHome?: false }): Promise<AdminGate>;
export async function integrationsAdmin(req: Request, opts: { adminOnly: boolean; withHome?: boolean }): Promise<AdminGate | AdminGateWithHome> {
  const blocked = sameOriginGuard(req);
  if (blocked) return { ok: false, response: blocked };
  const session = opts.withHome ? await getAdminContextWithHome() : null;
  const ctx = opts.withHome ? (session?.ctx ?? null) : await getAdminContext();
  if (!ctx) return { ok: false, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  if (opts.adminOnly && ctx.role !== "admin") {
    return { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  if (session) return { ok: true, ctx, home: { tenantId: session.homeTenantId, role: session.homeRole } };
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
