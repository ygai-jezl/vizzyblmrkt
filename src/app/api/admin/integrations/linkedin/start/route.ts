import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getAdminContext } from "@/lib/auth/session";
import {
  isLinkedInConfigured,
  linkedinClientId,
  buildLinkedInAuthorizeUrl,
  socialOrigin,
  LINKEDIN_STATE_COOKIE,
  LINKEDIN_OAUTH_PATH,
} from "@/lib/social/linkedin/oauth";
import { isSocialCryptoConfigured, signState } from "@/lib/social/crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Begin the LinkedIn OAuth flow: redirect to LinkedIn's authorize page with a signed,
 * tenant-bound `state` (CSRF). No PKCE (LinkedIn is a confidential client with a
 * secret). Static route — precedes the git `[provider]` dynamic route.
 */
export async function GET(req: Request) {
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isLinkedInConfigured() || !isSocialCryptoConfigured()) {
    return NextResponse.json({ error: "linkedin_not_configured" }, { status: 503 });
  }

  const origin = socialOrigin(req.headers);
  const redirectUri = `${origin}/api/admin/integrations/linkedin/callback`;
  // The nonce binds THIS signed state to the browser that began the flow: the callback
  // rejects a state whose nonce doesn't match the cookie (OAuth account-fixation defence).
  const nonce = randomUUID();
  const state = signState({ t: ctx.tenantId, p: "linkedin", n: nonce, ts: Date.now() });
  const url = buildLinkedInAuthorizeUrl({ clientId: linkedinClientId()!, redirectUri, state });

  const res = NextResponse.redirect(url);
  res.cookies.set(LINKEDIN_STATE_COOKIE, nonce, {
    httpOnly: true,
    secure: origin.startsWith("https"),
    sameSite: "lax",
    path: LINKEDIN_OAUTH_PATH,
    maxAge: 600,
  });
  return res;
}
