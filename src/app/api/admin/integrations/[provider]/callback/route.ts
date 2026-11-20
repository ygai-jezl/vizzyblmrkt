import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { integrationsHopAdmin } from "@/lib/integrations/admin";
import {
  GIT_STATE_COOKIE,
  PROVIDERS,
  gitCallbackPath,
  isGitProvider,
  oauthOrigin,
  grantedScopes,
  type GitProvider,
} from "@/lib/integrations/providers";
import { verifyState, encryptToken, gitRefreshAad } from "@/lib/integrations/crypto";
import { getTenantById, setTenantGitConnection } from "@/lib/tenant";
import { isGitRepoSelectionEnabled } from "@/lib/integrations/repos";
import { githubAppConfig, verifyUserInstallation } from "@/lib/integrations/githubApp";
import { isConnectorRevokeEnabled } from "@/lib/integrations/flags";
import { revokeReplacedGitConnection } from "@/lib/integrations/revoke";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATE_MAX_AGE_MS = 10 * 60 * 1000;

/** Back to the connections page. Clears the nonce cookie whenever the provider is known. */
function back(origin: string, params: Record<string, string>): NextResponse {
  const u = new URL(`${origin}/admin/account/connections`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = NextResponse.redirect(u.toString());
  const provider = params.provider;
  if (provider && isGitProvider(provider)) {
    res.cookies.delete({ name: GIT_STATE_COOKIE, path: gitCallbackPath(provider) });
  }
  return res;
}

/** The brand's stored connection for this provider, before this callback replaces it. */
async function priorConnection(tenantId: string, provider: GitProvider) {
  return (await getTenantById(tenantId))?.gitConnections?.[provider];
}

/**
 * OAuth callback: provider redirects here with code+state. CSRF is the signed,
 * tenant-bound state plus the nonce cookie set by /start, which binds the flow to the
 * browser that began it (no origin check: this hop is cross-site by nature). On
 * success: exchange code → token, fetch the account handle, encrypt + store, then
 * redirect back to the connections page. With repo selection on, a new connection
 * starts with NO repos chosen and the page opens the repo picker (`select=`), so the
 * token isn't usable until the admin picks which repos across their orgs to use.
 * With CONNECTOR_REVOKE_ENABLED on, a token this callback replaces (a reconnect, or an
 * older GitHub connection switched to the GitHub App) is revoked after the save, only
 * when it differs from the new one.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const origin = oauthOrigin(req.headers);
  const { provider } = await params;
  const gate = await integrationsHopAdmin();
  if (!gate.ok && gate.why === "signed_out") {
    // Signed out: to sign-in, and like every other exit, clear the nonce cookie.
    const res = NextResponse.redirect(`${origin}/login`);
    if (isGitProvider(provider)) res.cookies.delete({ name: GIT_STATE_COOKIE, path: gitCallbackPath(provider) });
    return res;
  }

  if (!isGitProvider(provider)) return back(origin, { status: "error", reason: "unknown_provider" });
  const cfg = PROVIDERS[provider];

  const sp = new URL(req.url).searchParams;
  if (sp.get("error")) {
    return back(origin, { status: "error", reason: sp.get("error") ?? "denied", provider });
  }
  const code = sp.get("code");
  const stateRaw = sp.get("state");
  // A customer changed the GitHub App's repositories on GitHub, which sends them
  // back here without our state. Nothing to store — the installation id is
  // unchanged and GitHub enforces the new repo list — so confirm, write nothing.
  if (provider === "github" && githubAppConfig() && sp.get("setup_action") === "update" && !stateRaw) {
    return back(origin, { status: "ok", provider, updated: "1" });
  }
  // An organisation MEMBER (not an owner) asked their org to install the app.
  // GitHub has notified the owners; there's no installation to store yet.
  if (provider === "github" && githubAppConfig() && sp.get("setup_action") === "request") {
    return back(origin, { status: "requested", provider });
  }
  // Everything below can store a connection: admins only. The two GitHub branches
  // above write nothing and stay open to anyone signed in, because GitHub sends
  // whoever changed the app there.
  if (!gate.ok) return back(origin, { status: "error", reason: "forbidden", provider });
  const { ctx } = gate;
  if (!code || !stateRaw) return back(origin, { status: "error", reason: "missing_code", provider });

  const state = verifyState(stateRaw);
  if (!state || state.t !== ctx.tenantId || state.p !== provider) {
    return back(origin, { status: "error", reason: "bad_state", provider });
  }
  if (typeof state.ts !== "number" || Date.now() - state.ts > STATE_MAX_AGE_MS) {
    return back(origin, { status: "error", reason: "state_expired", provider });
  }
  // Bind to the browser that started: the state's nonce must match the cookie from
  // /start, before any code is exchanged. Without it a signed state could be replayed
  // in another admin's browser to attach an attacker's account.
  const cookieNonce = (await cookies()).get(GIT_STATE_COOKIE)?.value ?? "";
  if (!cookieNonce || typeof state.n !== "string" || cookieNonce !== state.n) {
    return back(origin, { status: "error", reason: "bad_state", provider });
  }

  const redirectUri = `${origin}${gitCallbackPath(provider)}`;

  // GitHub App installation (read-only): store the installation, never a token.
  const app = provider === "github" ? githubAppConfig() : null;
  const installationId = Number(sp.get("installation_id"));
  const revokeReplaced = isConnectorRevokeEnabled();
  if (app && Number.isInteger(installationId) && installationId > 0) {
    try {
      const v = await verifyUserInstallation({ code, installationId, redirectUri }, app);
      if (!v.ok) return back(origin, { status: "error", reason: v.reason, provider });
      // Switch now: an older GitHub connection's token is replaced by the installation.
      const prior = revokeReplaced ? await priorConnection(ctx.tenantId, provider) : undefined;
      await setTenantGitConnection(ctx.tenantId, provider, {
        provider,
        kind: "app",
        installationId,
        accountLogin: v.accountLogin ?? undefined,
        scope: "contents:read",
        connectedBy: ctx.userId,
        connectedAt: new Date().toISOString(),
      });
      // After the save, best effort (never throws). An installation is never uninstalled.
      if (revokeReplaced) {
        await revokeReplacedGitConnection(ctx.tenantId, prior, { accessToken: null, refreshToken: null });
      }
      return back(origin, { status: "ok", provider });
    } catch {
      return back(origin, { status: "error", reason: "exception", provider });
    }
  }
  // With the read-only app configured, GitHub never falls back to the classic
  // OAuth app (which can also write).
  if (app) return back(origin, { status: "error", reason: "no_installation", provider });

  try {
    const tokRes = await fetch(cfg.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: cfg.clientId()!,
        client_secret: cfg.clientSecret()!,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    });
    const tok = (await tokRes.json().catch(() => ({}))) as {
      access_token?: string;
      scope?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!tokRes.ok || !tok.access_token) {
      return back(origin, { status: "error", reason: "token_exchange_failed", provider });
    }
    // If the provider reports granted scopes, ensure the clone scope was actually
    // granted (GitHub org-SSO / fine-grained de-selection) — else the connection
    // looks fine but private clones fail later with a generic error.
    if (tok.scope && !grantedScopes(tok.scope).has(cfg.requiredScope)) {
      return back(origin, { status: "error", reason: "insufficient_scope", provider });
    }

    let accountLogin: string | undefined;
    try {
      const userRes = await fetch(cfg.userApiUrl, {
        headers: {
          Authorization: `Bearer ${tok.access_token}`,
          Accept: "application/json",
          "User-Agent": "Vizzybl-Knowledge",
        },
      });
      const user = (await userRes.json().catch(() => ({}))) as Record<string, unknown>;
      if (typeof user[cfg.loginField] === "string") accountLogin = user[cfg.loginField] as string;
    } catch {
      /* handle is best-effort */
    }

    const repoSelection = isGitRepoSelectionEnabled();
    const prior = repoSelection || revokeReplaced ? await priorConnection(ctx.tenantId, provider) : undefined;
    // A reconnect keeps the repos already chosen; a first connect starts with none.
    const priorRepos = repoSelection ? prior?.repos : undefined;
    const now = Date.now();
    // GitLab access tokens last 2 hours, so keep the refresh token (sealed and bound
    // to this brand) and the expiry; src/lib/integrations/tokenRefresh.ts renews it
    // before each use. Classic GitHub tokens don't expire and are stored as before.
    // The whole connection is rewritten, so a reconnect also clears any reconnect mark.
    const gitlabRefresh =
      provider === "gitlab"
        ? {
            refreshEnc: tok.refresh_token
              ? encryptToken(tok.refresh_token, gitRefreshAad(ctx.tenantId, provider))
              : null,
            expiresAt:
              typeof tok.expires_in === "number" && tok.expires_in > 0
                ? new Date(now + tok.expires_in * 1000).toISOString()
                : null,
          }
        : {};
    await setTenantGitConnection(ctx.tenantId, provider, {
      provider,
      kind: "oauth",
      enc: encryptToken(tok.access_token),
      ...gitlabRefresh,
      accountLogin,
      scope: tok.scope ?? cfg.scope,
      connectedBy: ctx.userId,
      connectedAt: new Date(now).toISOString(),
      ...(repoSelection ? { repos: priorRepos ?? [] } : {}),
    });
    // After the save, best effort (never throws): revoke the token this reconnect
    // replaced, unless the provider handed back the same access or refresh token.
    if (revokeReplaced) {
      await revokeReplacedGitConnection(ctx.tenantId, prior, {
        accessToken: tok.access_token,
        refreshToken: tok.refresh_token ?? null,
      });
    }
    return back(origin, {
      status: "ok",
      provider,
      ...(repoSelection && !priorRepos?.length ? { select: provider } : {}),
    });
  } catch {
    return back(origin, { status: "error", reason: "exception", provider });
  }
}
