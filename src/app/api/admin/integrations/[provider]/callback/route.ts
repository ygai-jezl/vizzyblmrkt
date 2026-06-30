import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { PROVIDERS, isGitProvider, oauthOrigin, grantedScopes } from "@/lib/integrations/providers";
import { verifyState, encryptToken } from "@/lib/integrations/crypto";
import { setTenantGitConnection } from "@/lib/tenant";

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
 * redirect back to the connections page.
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
  if (!code || !stateRaw) return back(origin, { status: "error", reason: "missing_code", provider });

  const state = verifyState(stateRaw);
  if (!state || state.t !== ctx.tenantId || state.p !== provider) {
    return back(origin, { status: "error", reason: "bad_state", provider });
  }
  if (typeof state.ts !== "number" || Date.now() - state.ts > STATE_MAX_AGE_MS) {
    return back(origin, { status: "error", reason: "state_expired", provider });
  }

  const redirectUri = `${origin}/api/admin/integrations/${provider}/callback`;
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

    await setTenantGitConnection(ctx.tenantId, provider, {
      provider,
      enc: encryptToken(tok.access_token),
      accountLogin,
      scope: tok.scope ?? cfg.scope,
      connectedBy: ctx.userId,
      connectedAt: new Date().toISOString(),
    });
    return back(origin, { status: "ok", provider });
  } catch {
    return back(origin, { status: "error", reason: "exception", provider });
  }
}
