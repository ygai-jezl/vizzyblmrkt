import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getAdminContext } from "@/lib/auth/session";
import {
  PROVIDERS,
  authorizeScope,
  isGitProvider,
  isProviderConfigured,
  oauthOrigin,
} from "@/lib/integrations/providers";
import { isGitRepoSelectionEnabled } from "@/lib/integrations/repos";
import { isGitCryptoConfigured, signState } from "@/lib/integrations/crypto";
import { authorizeUrl, githubAppConfig, installUrl, isGitHubAppLinkEnabled } from "@/lib/integrations/githubApp";
import { connectState } from "@/lib/integrations/githubAppLink";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Begin the OAuth flow: redirect the browser to the provider's authorize page
 *  with a signed, tenant-bound `state` (CSRF). */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { provider } = await params;
  if (!isGitProvider(provider)) {
    return NextResponse.json({ error: "unknown_provider" }, { status: 400 });
  }
  const cfg = PROVIDERS[provider];
  // GitHub: install the read-only YouGrow GitHub App when it's set up. With
  // linking on, first ask GitHub who's connecting, so an app they've already
  // installed can be linked; `?install=1` goes straight to installing it.
  const app = provider === "github" ? githubAppConfig() : null;
  if (app) {
    if (!isGitHubAppLinkEnabled() || new URL(req.url).searchParams.get("install") === "1") {
      return NextResponse.redirect(installUrl(app, connectState(ctx.tenantId, "install")));
    }
    const redirectUri = `${oauthOrigin(req.headers)}/api/admin/integrations/github/callback`;
    return NextResponse.redirect(authorizeUrl(app, redirectUri, connectState(ctx.tenantId, "link")));
  }
  if (!isProviderConfigured(provider) || !isGitCryptoConfigured()) {
    return NextResponse.json({ error: "provider_not_configured" }, { status: 503 });
  }

  const origin = oauthOrigin(req.headers);
  const redirectUri = `${origin}/api/admin/integrations/${provider}/callback`;
  const state = signState({ t: ctx.tenantId, p: provider, n: randomUUID(), ts: Date.now() });

  const url = new URL(cfg.authorizeUrl);
  url.searchParams.set("client_id", cfg.clientId()!);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", authorizeScope(provider, isGitRepoSelectionEnabled()));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  return NextResponse.redirect(url.toString());
}
