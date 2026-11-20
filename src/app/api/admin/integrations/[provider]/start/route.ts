import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { integrationsHopAdmin } from "@/lib/integrations/admin";
import {
  GIT_STATE_COOKIE,
  PROVIDERS,
  authorizeScope,
  gitCallbackPath,
  isGitProvider,
  isProviderConfigured,
  oauthOrigin,
  type GitProvider,
} from "@/lib/integrations/providers";
import { isGitRepoSelectionEnabled } from "@/lib/integrations/repos";
import { isGitCryptoConfigured, signState } from "@/lib/integrations/crypto";
import { githubAppConfig, installUrl } from "@/lib/integrations/githubApp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Back to the connections page with a reason, for a member who pressed Connect. */
function forbidden(req: Request, provider: string): NextResponse {
  const u = new URL(`${oauthOrigin(req.headers)}/admin/account/connections`);
  u.searchParams.set("status", "error");
  u.searchParams.set("reason", "forbidden");
  if (isGitProvider(provider)) u.searchParams.set("provider", provider);
  return NextResponse.redirect(u.toString());
}

/** Redirect to the provider with the nonce cookie that binds this flow to this browser.
 *  SameSite=Lax so it survives the top-level GET back from the provider; path-scoped to
 *  the callback (its only reader); httpOnly so scripts can't read it. */
function redirectWithNonce(url: string, provider: GitProvider, nonce: string, origin: string): NextResponse {
  const res = NextResponse.redirect(url);
  res.cookies.set(GIT_STATE_COOKIE, nonce, {
    httpOnly: true,
    secure: origin.startsWith("https"),
    sameSite: "lax",
    path: gitCallbackPath(provider),
    maxAge: 600,
  });
  return res;
}

/** Begin the OAuth flow: redirect the browser to the provider's authorize page
 *  with a signed, tenant-bound `state` (CSRF) and a browser-bound nonce. Admins only. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  const gate = await integrationsHopAdmin();
  if (!gate.ok) {
    if (gate.why === "signed_out") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    return forbidden(req, provider);
  }
  const { ctx } = gate;

  if (!isGitProvider(provider)) {
    return NextResponse.json({ error: "unknown_provider" }, { status: 400 });
  }
  const cfg = PROVIDERS[provider];
  const origin = oauthOrigin(req.headers);
  // The callback rejects a state whose nonce doesn't match this browser's cookie.
  const nonce = randomUUID();
  // GitHub: install the read-only YouGrow GitHub App when it's set up.
  const app = provider === "github" ? githubAppConfig() : null;
  if (app) {
    const state = signState({ t: ctx.tenantId, p: provider, n: nonce, ts: Date.now() });
    return redirectWithNonce(installUrl(app, state), provider, nonce, origin);
  }
  if (!isProviderConfigured(provider) || !isGitCryptoConfigured()) {
    return NextResponse.json({ error: "provider_not_configured" }, { status: 503 });
  }

  const redirectUri = `${origin}${gitCallbackPath(provider)}`;
  const state = signState({ t: ctx.tenantId, p: provider, n: nonce, ts: Date.now() });

  const url = new URL(cfg.authorizeUrl);
  url.searchParams.set("client_id", cfg.clientId()!);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", authorizeScope(provider, isGitRepoSelectionEnabled()));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  return redirectWithNonce(url.toString(), provider, nonce, origin);
}
