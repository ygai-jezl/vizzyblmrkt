import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { PROVIDERS, isGitProvider, oauthOrigin, grantedScopes } from "@/lib/integrations/providers";
import { verifyState, encryptToken } from "@/lib/integrations/crypto";
import { getTenantById, setTenantGitConnection } from "@/lib/tenant";
import { isGitRepoSelectionEnabled } from "@/lib/integrations/repos";
import {
  githubAppConfig,
  installUrl,
  isGitHubAppLinkEnabled,
  listUserInstallations,
  verifyUserInstallation,
} from "@/lib/integrations/githubApp";
import { chooseToken, connectState, saveAppConnection } from "@/lib/integrations/githubAppLink";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATE_MAX_AGE_MS = 10 * 60 * 1000;

function back(origin: string, params: Record<string, string>): NextResponse {
  const u = new URL(`${origin}/admin/account/connections`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return NextResponse.redirect(u.toString());
}

/**
 * OAuth callback: provider redirects here with code+state. CSRF is the signed,
 * tenant-bound state (no sameOriginGuard — this hop is cross-site by nature). On
 * success: exchange code → token, fetch the account handle, encrypt + store, then
 * redirect back to the connections page. With repo selection on, a new connection
 * starts with NO repos chosen and the page opens the repo picker (`select=`), so the
 * token isn't usable until the admin picks which repos across their orgs to use.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const origin = oauthOrigin(req.headers);
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.redirect(`${origin}/login`);

  const { provider } = await params;
  if (!isGitProvider(provider)) return back(origin, { status: "error", reason: "unknown_provider" });
  const cfg = PROVIDERS[provider];

  const sp = new URL(req.url).searchParams;
  if (sp.get("error")) {
    return back(origin, { status: "error", reason: sp.get("error") ?? "denied", provider });
  }
  const code = sp.get("code");
  const stateRaw = sp.get("state");
  const redirectUri = `${origin}/api/admin/integrations/${provider}/callback`;
  const app = provider === "github" ? githubAppConfig() : null;
  const linking = app && isGitHubAppLinkEnabled() ? app : null;
  const installationId = Number(sp.get("installation_id"));
  const hasInstallation = Number.isInteger(installationId) && installationId > 0;

  // An organisation MEMBER (not an owner) asked their org to install the app.
  // GitHub has notified the owners; there's no installation to store yet.
  if (app && sp.get("setup_action") === "request") {
    return back(origin, { status: "requested", provider });
  }
  // A customer changed the GitHub App's repositories on GitHub, which sends them
  // back here without our state. Nothing to store — the installation id is
  // unchanged and GitHub enforces the new repo list — so confirm, write nothing.
  if (app && sp.get("setup_action") === "update" && !stateRaw) {
    return back(origin, { status: "ok", provider, updated: "1" });
  }
  if (!code || !stateRaw) return back(origin, { status: "error", reason: "missing_code", provider });

  const state = verifyState(stateRaw);
  // A "choose" token only lists installs to pick from; it never stands in for OAuth state.
  if (!state || state.t !== ctx.tenantId || state.p !== provider || state.m === "choose") {
    return back(origin, { status: "error", reason: "bad_state", provider });
  }
  if (typeof state.ts !== "number" || Date.now() - state.ts > STATE_MAX_AGE_MS) {
    return back(origin, { status: "error", reason: "state_expired", provider });
  }

  // The person authorised the app on GitHub: find the installs they can use.
  if (linking && state.m === "link" && !hasInstallation) {
    try {
      const r = await listUserInstallations({ code, redirectUri }, linking);
      if (!r.ok) return back(origin, { status: "error", reason: r.reason, provider });
      const usable = r.installations.filter((i) => i.readOnly);
      // Not installed anywhere they can reach yet: on to GitHub's install page.
      if (usable.length === 0) return NextResponse.redirect(installUrl(linking, connectState(ctx.tenantId, "install")));
      // Always ask, even with one: nothing is linked without a click (a crafted
      // link can't attach an install to whichever workspace is open), and someone
      // whose personal account already has the app can still install it on their
      // organisation. An install GitHub just told us about goes first.
      const hint = typeof state.i === "number" ? state.i : null;
      usable.sort((a, b) => Number(b.installationId === hint) - Number(a.installationId === hint));
      return back(origin, { choose: provider, c: chooseToken(ctx.tenantId, usable) });
    } catch {
      return back(origin, { status: "error", reason: "exception", provider });
    }
  }

  // GitHub App installation (read-only): store the installation, never a token.
  if (app && hasInstallation) {
    try {
      const v = await verifyUserInstallation({ code, installationId, redirectUri }, app);
      if (!v.ok) return back(origin, { status: "error", reason: v.reason, provider });
      await saveAppConnection(ctx.tenantId, ctx.userId, { installationId, accountLogin: v.accountLogin, accountType: v.accountType });
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
    // A reconnect keeps the repos already chosen; a first connect starts with none.
    const priorRepos = repoSelection
      ? (await getTenantById(ctx.tenantId))?.gitConnections?.[provider]?.repos
      : undefined;
    await setTenantGitConnection(ctx.tenantId, provider, {
      provider,
      kind: "oauth",
      enc: encryptToken(tok.access_token),
      accountLogin,
      scope: tok.scope ?? cfg.scope,
      connectedBy: ctx.userId,
      connectedAt: new Date().toISOString(),
      ...(repoSelection ? { repos: priorRepos ?? [] } : {}),
    });
    return back(origin, {
      status: "ok",
      provider,
      ...(repoSelection && !priorRepos?.length ? { select: provider } : {}),
    });
  } catch {
    return back(origin, { status: "error", reason: "exception", provider });
  }
}
