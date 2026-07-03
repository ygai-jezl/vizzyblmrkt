import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAdminContext } from "@/lib/auth/session";
import {
  isLinkedInConfigured,
  linkedinClientId,
  linkedinClientSecret,
  socialOrigin,
  LINKEDIN_TOKEN_URL,
  LINKEDIN_USERINFO_URL,
  LINKEDIN_SCOPES,
  LINKEDIN_STATE_COOKIE,
  LINKEDIN_OAUTH_PATH,
  type LinkedInTokenResponse,
} from "@/lib/social/linkedin/oauth";
import { verifyState, encryptToken } from "@/lib/social/crypto";
import { setTenantSocialConnection } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATE_MAX_AGE_MS = 10 * 60 * 1000;

function back(origin: string, params: Record<string, string>): NextResponse {
  const u = new URL(`${origin}/admin/account/connections`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = NextResponse.redirect(u.toString());
  res.cookies.delete({ name: LINKEDIN_STATE_COOKIE, path: LINKEDIN_OAUTH_PATH });
  return res;
}

/**
 * LinkedIn OAuth callback. CSRF is the signed, tenant-bound `state`. On success:
 * exchange code → token (client_id/secret in the BODY, no PKCE), fetch the member's
 * OpenID `sub` (the author URN for posting) + name, encrypt + store on the tenant.
 */
export async function GET(req: Request) {
  const origin = socialOrigin(req.headers);
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.redirect(`${origin}/login`);
  if (!isLinkedInConfigured()) {
    return back(origin, { status: "error", reason: "linkedin_not_configured", provider: "linkedin" });
  }

  const sp = new URL(req.url).searchParams;
  if (sp.get("error")) {
    return back(origin, { status: "error", reason: sp.get("error") ?? "denied", provider: "linkedin" });
  }
  const code = sp.get("code");
  const stateRaw = sp.get("state");
  if (!code || !stateRaw) return back(origin, { status: "error", reason: "missing_code", provider: "linkedin" });

  const state = verifyState(stateRaw);
  if (!state || state.t !== ctx.tenantId || state.p !== "linkedin") {
    return back(origin, { status: "error", reason: "bad_state", provider: "linkedin" });
  }
  if (typeof state.ts !== "number" || Date.now() - state.ts > STATE_MAX_AGE_MS) {
    return back(origin, { status: "error", reason: "state_expired", provider: "linkedin" });
  }
  // Bind to the initiating browser: the state nonce MUST match the cookie set in /start.
  // Without this, a signed tenant-state is replayable into another admin's session to
  // redeem an attacker's authorization code (OAuth account-fixation).
  const cookieNonce = (await cookies()).get(LINKEDIN_STATE_COOKIE)?.value ?? "";
  if (!cookieNonce || typeof state.n !== "string" || cookieNonce !== state.n) {
    return back(origin, { status: "error", reason: "bad_state", provider: "linkedin" });
  }

  const redirectUri = `${origin}/api/admin/integrations/linkedin/callback`;
  try {
    const tokRes = await fetch(LINKEDIN_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: linkedinClientId()!,
        client_secret: linkedinClientSecret()!,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const tok = (await tokRes.json().catch(() => ({}))) as LinkedInTokenResponse;
    if (!tokRes.ok || !tok.access_token) {
      return back(origin, { status: "error", reason: "token_exchange_failed", provider: "linkedin" });
    }

    // Identity: the OpenID `sub` is the member id → the author URN we post as. Name is
    // best-effort display. Without a sub we can't post, so treat that as a failure.
    let userId: string | undefined;
    let handle: string | undefined;
    try {
      const meRes = await fetch(LINKEDIN_USERINFO_URL, {
        headers: { Authorization: `Bearer ${tok.access_token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      });
      const me = (await meRes.json().catch(() => ({}))) as { sub?: string; name?: string };
      if (typeof me.sub === "string") userId = me.sub;
      if (typeof me.name === "string") handle = me.name;
    } catch {
      /* best-effort */
    }
    if (!userId) {
      return back(origin, { status: "error", reason: "no_member_id", provider: "linkedin" });
    }

    await setTenantSocialConnection(ctx.tenantId, "linkedin", {
      platform: "linkedin",
      enc: encryptToken(tok.access_token),
      refreshEnc: tok.refresh_token ? encryptToken(tok.refresh_token) : null,
      handle,
      userId,
      scope: tok.scope ?? LINKEDIN_SCOPES,
      expiresAt: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : null,
      connectedBy: ctx.userId,
      connectedAt: new Date().toISOString(),
    });
    return back(origin, { status: "ok", provider: "linkedin" });
  } catch {
    return back(origin, { status: "error", reason: "exception", provider: "linkedin" });
  }
}
