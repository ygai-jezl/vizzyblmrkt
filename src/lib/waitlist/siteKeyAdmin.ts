import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { originFromHeaders } from "@/lib/http/origin";
import { platformOrigin } from "@/lib/platform/origin";
import { forTenant, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { isSiteSignupsEnabled } from "./siteFlags";
import { invalidateSiteKeyCaches } from "./siteKeyAuth";
import {
  createSiteKey,
  isSiteKeyCryptoConfigured,
  revokeSiteKey,
  rotateSiteKey,
  setSiteConfirmedUrl,
  siteKeyView,
  type SiteKeyView,
} from "./siteKeys";
import { SITE_SIGNUPS_PATH } from "./siteSignupContract";

/**
 * The admin APIs behind a launch's "Your own form" panel (LAUNCH_SITE_SIGNUPS_ENABLED):
 * the key's status, Create site key, Rotate secret, Revoke key and Send them to.
 * Gate: origin, switch, sign-in, then admin for anything that changes; the launch
 * must be this brand's. A secret is returned once, by Create or Rotate, never again.
 */

export interface SiteKeyAdminDeps {
  db?: FirestoreLike;
  nowMs?: number;
}

const json = (status: number, body: unknown) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

type Gate = { ok: true; ctx: TenantContext } | { ok: false; response: Response };

async function gate(req: Request, campaignId: string, write: boolean, deps: SiteKeyAdminDeps): Promise<Gate> {
  const blocked = sameOriginGuard(req);
  if (blocked) return { ok: false, response: blocked };
  if (!isSiteSignupsEnabled()) return { ok: false, response: json(503, { error: "site_signups_disabled" }) };
  const ctx = await getAdminContext();
  if (!ctx) return { ok: false, response: json(401, { error: "unauthorized" }) };
  if (write && ctx.role !== "admin") return { ok: false, response: json(403, { error: "forbidden" }) };
  const campaign = await forTenant(ctx, deps.db).campaigns.getById(campaignId);
  if (!campaign) return { ok: false, response: json(404, { error: "launch_not_found" }) };
  return { ok: true, ctx };
}

/** The address the brand's server calls: the platform's own, else this request's. */
function endpointFor(req: Request): string {
  return `${platformOrigin() || originFromHeaders(req.headers)}${SITE_SIGNUPS_PATH}`;
}

async function currentView(ctx: TenantContext, campaignId: string, deps: SiteKeyAdminDeps): Promise<SiteKeyView | null> {
  const key = await forTenant(ctx, deps.db).siteKeys.getById(campaignId);
  return key && key.status === "active" ? siteKeyView(key, deps.nowMs ?? Date.now()) : null;
}

/** GET: the key (never its secret) and the address to call. Members may look. */
export async function handleGetSiteKey(req: Request, campaignId: string, deps: SiteKeyAdminDeps = {}): Promise<Response> {
  const g = await gate(req, campaignId, false, deps);
  if (!g.ok) return g.response;
  return json(200, { key: await currentView(g.ctx, campaignId, deps), endpoint: endpointFor(req), canCreate: isSiteKeyCryptoConfigured() });
}

/** POST: Create site key. The secret comes back this once. */
export async function handleCreateSiteKey(req: Request, campaignId: string, deps: SiteKeyAdminDeps = {}): Promise<Response> {
  const g = await gate(req, campaignId, true, deps);
  if (!g.ok) return g.response;
  if (!isSiteKeyCryptoConfigured()) return json(503, { error: "encryption_unavailable" });
  const r = await createSiteKey(g.ctx, campaignId, { createdBy: g.ctx.userId ?? null, db: deps.db, nowMs: deps.nowMs });
  if ("error" in r) return json(409, { error: "key_exists" });
  return json(201, { key: siteKeyView(r.key, deps.nowMs ?? Date.now()), secret: r.secret });
}

/** POST …/rotate: Rotate secret. The old one works 24 hours more. */
export async function handleRotateSiteKey(req: Request, campaignId: string, deps: SiteKeyAdminDeps = {}): Promise<Response> {
  const g = await gate(req, campaignId, true, deps);
  if (!g.ok) return g.response;
  if (!isSiteKeyCryptoConfigured()) return json(503, { error: "encryption_unavailable" });
  const r = await rotateSiteKey(g.ctx, campaignId, deps);
  if (!r) return json(404, { error: "no_key" });
  const view = await currentView(g.ctx, campaignId, deps);
  if (view) invalidateSiteKeyCaches(view.keyId, g.ctx.tenantId, campaignId);
  return json(200, { key: view, secret: r.secret });
}

/** DELETE: Revoke key. Calls stop within a minute (the key cache). */
export async function handleRevokeSiteKey(req: Request, campaignId: string, deps: SiteKeyAdminDeps = {}): Promise<Response> {
  const g = await gate(req, campaignId, true, deps);
  if (!g.ok) return g.response;
  const before = await forTenant(g.ctx, deps.db).siteKeys.getById(campaignId);
  if (!(await revokeSiteKey(g.ctx, campaignId, deps))) return json(404, { error: "no_key" });
  if (before) invalidateSiteKeyCaches(before.keyId, g.ctx.tenantId, campaignId);
  return json(200, { revoked: true });
}

const ThankYouSchema = z
  .object({
    siteConfirmedUrl: z
      .string()
      .trim()
      .max(2000)
      .url()
      .refine((u) => u.startsWith("https://"), { message: "use an https address" })
      .nullable(),
  })
  .strict();

/** PATCH: Send them to (https), or null for the "You're subscribed" page. */
export async function handlePatchSiteKey(req: Request, campaignId: string, deps: SiteKeyAdminDeps = {}): Promise<Response> {
  const g = await gate(req, campaignId, true, deps);
  if (!g.ok) return g.response;
  const raw = (await req.json().catch(() => null)) as { siteConfirmedUrl?: unknown } | null;
  // An empty box means "no thank-you page".
  const body = raw && raw.siteConfirmedUrl === "" ? { ...raw, siteConfirmedUrl: null } : raw;
  const parsed = ThankYouSchema.safeParse(body);
  if (!parsed.success) return json(400, { error: "invalid_url", message: "Use a full https address, like https://example.com/thanks." });
  if (!(await setSiteConfirmedUrl(g.ctx, campaignId, parsed.data.siteConfirmedUrl, deps))) return json(404, { error: "no_key" });
  return json(200, { key: await currentView(g.ctx, campaignId, deps) });
}
