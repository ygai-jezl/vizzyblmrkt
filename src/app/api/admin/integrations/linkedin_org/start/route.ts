import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getAdminContext } from "@/lib/auth/session";
import {
  isLinkedInCMConfigured,
  linkedinCmClientId,
  buildLinkedInAuthorizeUrl,
  socialOrigin,
  LINKEDIN_ORG_SCOPES,
  LINKEDIN_ORG_STATE_COOKIE,
  LINKEDIN_ORG_OAUTH_PATH,
} from "@/lib/social/linkedin/oauth";
import { isSocialCryptoConfigured, signState } from "@/lib/social/crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Begin the LinkedIn Community-Management (Company Page) OAuth flow — App 2, its own
 * credentials + org scopes. Signed tenant-bound state + a browser-bound nonce cookie
 * (OAuth account-fixation defence), mirroring the personal LinkedIn flow.
 */
export async function GET(req: Request) {
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isLinkedInCMConfigured() || !isSocialCryptoConfigured()) {
    return NextResponse.json({ error: "linkedin_cm_not_configured" }, { status: 503 });
  }

  const origin = socialOrigin(req.headers);
  const redirectUri = `${origin}/api/admin/integrations/linkedin_org/callback`;
  const nonce = randomUUID();
  const state = signState({ t: ctx.tenantId, p: "linkedin_org", n: nonce, ts: Date.now() });
  const url = buildLinkedInAuthorizeUrl({
    clientId: linkedinCmClientId()!,
    redirectUri,
    state,
    scope: LINKEDIN_ORG_SCOPES,
  });

  const res = NextResponse.redirect(url);
  res.cookies.set(LINKEDIN_ORG_STATE_COOKIE, nonce, {
    httpOnly: true,
    secure: origin.startsWith("https"),
    sameSite: "lax",
    path: LINKEDIN_ORG_OAUTH_PATH,
    maxAge: 600,
  });
  return res;
}
