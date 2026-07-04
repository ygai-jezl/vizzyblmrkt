import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAdminContext } from "@/lib/auth/session";
import {
  isLinkedInCMConfigured,
  linkedinCmClientId,
  linkedinCmClientSecret,
  socialOrigin,
  LINKEDIN_TOKEN_URL,
  LINKEDIN_ORG_SCOPES,
  LINKEDIN_ORG_STATE_COOKIE,
  LINKEDIN_ORG_OAUTH_PATH,
  type LinkedInTokenResponse,
} from "@/lib/social/linkedin/oauth";
import { fetchAdminOrganizations } from "@/lib/social/linkedin/orgs";
import { verifyState, encryptToken } from "@/lib/social/crypto";
import { setTenantSocialConnection, getTenantById } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATE_MAX_AGE_MS = 10 * 60 * 1000;

function back(origin: string, params: Record<string, string>): NextResponse {
  const u = new URL(`${origin}/admin/account/connections`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = NextResponse.redirect(u.toString());
  res.cookies.delete({ name: LINKEDIN_ORG_STATE_COOKIE, path: LINKEDIN_ORG_OAUTH_PATH });
  return res;
}

/**
 * LinkedIn CM (Company Page) OAuth callback. Verifies tenant-bound state + the
 * browser-bound nonce cookie, exchanges the code (App-2 client_secret in the body),
 * then discovers the Pages the member administers (organizationAcls) and stores them
 * on the `linkedin_org` connection — those are the selectable authors for a page post.
 */
export async function GET(req: Request) {
  const origin = socialOrigin(req.headers);
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.redirect(`${origin}/login`);
  if (!isLinkedInCMConfigured()) {
    return back(origin, { status: "error", reason: "linkedin_cm_not_configured", provider: "linkedin_org" });
  }

  const sp = new URL(req.url).searchParams;
  if (sp.get("error")) {
    return back(origin, { status: "error", reason: sp.get("error") ?? "denied", provider: "linkedin_org" });
  }
  const code = sp.get("code");
  const stateRaw = sp.get("state");
  if (!code || !stateRaw) return back(origin, { status: "error", reason: "missing_code", provider: "linkedin_org" });

  const state = verifyState(stateRaw);
  if (!state || state.t !== ctx.tenantId || state.p !== "linkedin_org") {
    return back(origin, { status: "error", reason: "bad_state", provider: "linkedin_org" });
  }
  if (typeof state.ts !== "number" || Date.now() - state.ts > STATE_MAX_AGE_MS) {
    return back(origin, { status: "error", reason: "state_expired", provider: "linkedin_org" });
  }
  const cookieNonce = (await cookies()).get(LINKEDIN_ORG_STATE_COOKIE)?.value ?? "";
  if (!cookieNonce || typeof state.n !== "string" || cookieNonce !== state.n) {
    return back(origin, { status: "error", reason: "bad_state", provider: "linkedin_org" });
  }

  const redirectUri = `${origin}/api/admin/integrations/linkedin_org/callback`;
  try {
    const tokRes = await fetch(LINKEDIN_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: linkedinCmClientId()!,
        client_secret: linkedinCmClientSecret()!,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const tok = (await tokRes.json().catch(() => ({}))) as LinkedInTokenResponse;
    if (!tokRes.ok || !tok.access_token) {
      return back(origin, { status: "error", reason: "token_exchange_failed", provider: "linkedin_org" });
    }

    // Discover the Pages the member administers (the selectable authors). Fail-soft:
    // an empty list still connects. But if the ACLs call itself FAILED (transient blip),
    // preserve any prior pages rather than clobbering a working list with [].
    const discovered = await fetchAdminOrganizations(tok.access_token);
    let orgs = discovered.orgs;
    if (!discovered.ok) {
      const prior = (await getTenantById(ctx.tenantId).catch(() => null))?.socialConnections
        ?.linkedin_org?.orgs;
      orgs = (prior ?? []).map((o) => ({ urn: o.urn, name: o.name ?? null }));
    }

    await setTenantSocialConnection(ctx.tenantId, "linkedin_org", {
      platform: "linkedin_org",
      enc: encryptToken(tok.access_token),
      refreshEnc: tok.refresh_token ? encryptToken(tok.refresh_token) : null,
      orgs,
      scope: tok.scope ?? LINKEDIN_ORG_SCOPES,
      expiresAt: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : null,
      connectedBy: ctx.userId,
      connectedAt: new Date().toISOString(),
    });
    return back(origin, { status: "ok", provider: "linkedin_org" });
  } catch {
    return back(origin, { status: "error", reason: "exception", provider: "linkedin_org" });
  }
}
