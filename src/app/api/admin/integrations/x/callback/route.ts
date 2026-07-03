import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAdminContext } from "@/lib/auth/session";
import {
  isXConfigured,
  xClientId,
  xClientSecret,
  basicAuthHeader,
  socialOrigin,
  X_TOKEN_URL,
  X_ME_URL,
  X_SCOPES,
  X_PKCE_COOKIE,
  X_OAUTH_PATH,
  type XTokenResponse,
} from "@/lib/social/x/oauth";
import { verifyState, encryptToken } from "@/lib/social/crypto";
import { setTenantSocialConnection, setSocialSubscription } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATE_MAX_AGE_MS = 10 * 60 * 1000;

function back(origin: string, params: Record<string, string>): NextResponse {
  const u = new URL(`${origin}/admin/account/connections`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = NextResponse.redirect(u.toString());
  res.cookies.delete({ name: X_PKCE_COOKIE, path: X_OAUTH_PATH });
  return res;
}

/**
 * X OAuth callback: X redirects here with code+state. CSRF is the signed,
 * tenant-bound state (cross-site hop by nature). On success: exchange code + PKCE
 * verifier → tokens (confidential client → Basic auth), fetch the handle, encrypt +
 * store on the tenant, redirect back to the connections page.
 */
export async function GET(req: Request) {
  const origin = socialOrigin(req.headers);
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.redirect(`${origin}/login`);
  if (!isXConfigured()) return back(origin, { status: "error", reason: "x_not_configured", provider: "x" });

  const sp = new URL(req.url).searchParams;
  if (sp.get("error")) {
    return back(origin, { status: "error", reason: sp.get("error") ?? "denied", provider: "x" });
  }
  const code = sp.get("code");
  const stateRaw = sp.get("state");
  if (!code || !stateRaw) return back(origin, { status: "error", reason: "missing_code", provider: "x" });

  const state = verifyState(stateRaw);
  if (!state || state.t !== ctx.tenantId || state.p !== "x") {
    return back(origin, { status: "error", reason: "bad_state", provider: "x" });
  }
  if (typeof state.ts !== "number" || Date.now() - state.ts > STATE_MAX_AGE_MS) {
    return back(origin, { status: "error", reason: "state_expired", provider: "x" });
  }

  // Cookie is `<nonce>.<verifier>`; the nonce MUST match this state's nonce so a
  // stray/concurrent-flow cookie can't be used to complete a different flow.
  const rawCookie = (await cookies()).get(X_PKCE_COOKIE)?.value ?? "";
  const dot = rawCookie.indexOf(".");
  const cookieNonce = dot > 0 ? rawCookie.slice(0, dot) : "";
  const verifier = dot > 0 ? rawCookie.slice(dot + 1) : "";
  if (!verifier || typeof state.n !== "string" || cookieNonce !== state.n) {
    return back(origin, { status: "error", reason: "bad_pkce", provider: "x" });
  }

  const redirectUri = `${origin}/api/admin/integrations/x/callback`;
  try {
    const tokRes = await fetch(X_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Authorization: basicAuthHeader(xClientId()!, xClientSecret()!),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        client_id: xClientId()!,
      }),
      signal: AbortSignal.timeout(10_000), // don't hang the OAuth redirect on a slow X
    });
    const tok = (await tokRes.json().catch(() => ({}))) as XTokenResponse;
    if (!tokRes.ok || !tok.access_token) {
      return back(origin, { status: "error", reason: "token_exchange_failed", provider: "x" });
    }

    // Handle + numeric id are best-effort (GET /2/users/me). The id is the
    // attribution key for inbound engagement webhooks (see social_subscriptions).
    let handle: string | undefined;
    let userId: string | undefined;
    try {
      const meRes = await fetch(X_ME_URL, {
        headers: { Authorization: `Bearer ${tok.access_token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      });
      const me = (await meRes.json().catch(() => ({}))) as { data?: { username?: string; id?: string } };
      if (typeof me.data?.username === "string") handle = me.data.username;
      if (typeof me.data?.id === "string") userId = me.data.id;
    } catch {
      /* best-effort */
    }

    const connectedAt = new Date().toISOString();
    await setTenantSocialConnection(ctx.tenantId, "x", {
      platform: "x",
      enc: encryptToken(tok.access_token),
      refreshEnc: tok.refresh_token ? encryptToken(tok.refresh_token) : null,
      handle,
      userId,
      scope: tok.scope ?? X_SCOPES,
      expiresAt: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : null,
      connectedBy: ctx.userId,
      connectedAt,
    });
    // Attribution map for inbound webhooks (needs the numeric id; best-effort).
    if (userId) {
      const claim = await setSocialSubscription({
        tenantId: ctx.tenantId,
        region: ctx.region,
        platform: "x",
        userId,
        handle,
        connectedAt,
      }).catch(() => null);
      if (claim === "held_by_other") {
        // Publishing still works; only the inbound-webhook attribution is not claimed.
        console.warn(`[x-oauth] account ${userId} is mapped to another tenant; not reclaiming for ${ctx.tenantId}`);
      }
    }
    return back(origin, { status: "ok", provider: "x" });
  } catch {
    return back(origin, { status: "error", reason: "exception", provider: "x" });
  }
}
