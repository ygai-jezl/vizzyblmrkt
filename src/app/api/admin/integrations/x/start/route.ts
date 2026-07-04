import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getAdminContext } from "@/lib/auth/session";
import {
  isXConfigured,
  xClientId,
  generatePkce,
  buildXAuthorizeUrl,
  socialOrigin,
  X_PKCE_COOKIE,
  X_OAUTH_PATH,
} from "@/lib/social/x/oauth";
import { isSocialCryptoConfigured, signState } from "@/lib/social/crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Begin the X OAuth 2.0 + PKCE flow: redirect to X's authorize page with a signed,
 * tenant-bound `state` (CSRF), and stash the PKCE verifier in a short-lived httpOnly
 * cookie (round-trips to /callback). Static route — takes precedence over the git
 * `[provider]` dynamic route for the `/integrations/x/*` path.
 */
export async function GET(req: Request) {
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isXConfigured() || !isSocialCryptoConfigured()) {
    return NextResponse.json({ error: "x_not_configured" }, { status: 503 });
  }

  const origin = socialOrigin(req.headers);
  const redirectUri = `${origin}/api/admin/integrations/x/callback`;
  const { verifier, challenge } = generatePkce();
  // The nonce binds the cookie to THIS signed state: the callback rejects a cookie
  // whose nonce doesn't match state.n (defeats concurrent-flow cookie confusion).
  const nonce = randomUUID();
  const state = signState({ t: ctx.tenantId, p: "x", n: nonce, ts: Date.now() });
  const url = buildXAuthorizeUrl({
    clientId: xClientId()!,
    redirectUri,
    state,
    codeChallenge: challenge,
  });

  const res = NextResponse.redirect(url);
  // SameSite=Lax so the cookie survives the top-level GET redirect back from x.com;
  // path-scoped to /callback (its only reader); httpOnly so JS can't read it.
  res.cookies.set(X_PKCE_COOKIE, `${nonce}.${verifier}`, {
    httpOnly: true,
    secure: origin.startsWith("https"),
    sameSite: "lax",
    path: X_OAUTH_PATH,
    maxAge: 600,
  });
  return res;
}
