import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exchangeGoogleCode,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  googleAuthorizeUrl,
  googleClient,
  refreshGoogleToken,
  revokeGoogleToken,
  tokenFailureCode,
} from "./google";

// Google is never called: every request goes to a stub transport.
const NOW = new Date("2026-11-21T10:00:00.000Z");
const client = { clientId: "made-up-client.example.test", clientSecret: "made-up-client-secret" };
const answer = (body: unknown, status = 200) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

afterEach(() => vi.unstubAllEnvs());

describe("Google sign in calls", () => {
  it("reads the client only when both halves are set", () => {
    vi.stubEnv("CONNECTOR_GOOGLE_CLIENT_ID", "made-up-client.example.test");
    vi.stubEnv("CONNECTOR_GOOGLE_CLIENT_SECRET", "");
    expect(googleClient()).toBeNull();
    vi.stubEnv("CONNECTOR_GOOGLE_CLIENT_SECRET", " made-up-client-secret ");
    expect(googleClient()).toEqual(client);
  });

  it("asks for offline access, consent every time, one scope and PKCE S256, never earlier grants", () => {
    const url = new URL(googleAuthorizeUrl({ clientId: client.clientId, redirectUri: "https://app.example.test/api/admin/connectors/callback", scope: SCOPE, state: "s.t", codeChallenge: "c" }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: client.clientId,
      redirect_uri: "https://app.example.test/api/admin/connectors/callback",
      response_type: "code",
      scope: SCOPE,
      access_type: "offline",
      prompt: "consent",
      state: "s.t",
      code_challenge: "c",
      code_challenge_method: "S256",
    });
    expect(url.searchParams.has("include_granted_scopes")).toBe(false);
  });

  it("swaps a code with its verifier, and reads what was granted", async () => {
    const transport = vi.fn(async () => answer({ access_token: "a", refresh_token: "r", expires_in: 3599, scope: `${SCOPE} openid`, token_type: "Bearer" }));
    const r = await exchangeGoogleCode({ code: "made-up-code", redirectUri: "https://app.example.test/cb", codeVerifier: "v" }, client, { transport, now: NOW });
    expect(r).toEqual({ ok: true, tokens: { accessToken: "a", refreshToken: "r", expiresAt: "2026-11-21T10:59:59.000Z", scopes: [SCOPE, "openid"] } });
    const [url, init, opts] = transport.mock.calls[0] as unknown as [string, RequestInit, unknown];
    expect(url).toBe(GOOGLE_TOKEN_URL);
    expect(opts).toEqual({ maxRedirects: 0, allowedPorts: [443], timeoutMs: 10_000 });
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      grant_type: "authorization_code",
      code: "made-up-code",
      redirect_uri: "https://app.example.test/cb",
      code_verifier: "v",
      client_id: client.clientId,
      client_secret: client.clientSecret,
    });
  });

  it("names each refusal by Google's error field, and never logs a token or a secret", async () => {
    expect(tokenFailureCode(400, { error: "invalid_grant" })).toBe("signin_refused");
    expect(tokenFailureCode(401, { error: "invalid_client" })).toBe("signin_unconfigured");
    expect(tokenFailureCode(400, { error: "unauthorized_client" })).toBe("signin_unconfigured");
    expect(tokenFailureCode(429, null)).toBe("rate_limited");
    expect(tokenFailureCode(503, null)).toBe("provider_error");
    expect(tokenFailureCode(400, { error: "invalid_request" })).toBe("provider_error");
    const log = vi.fn();
    const r = await refreshGoogleToken("made-up-refresh", client, { transport: async () => answer({ error: "invalid_grant" }, 400), log });
    expect(r).toEqual({ ok: false, code: "signin_refused", retryAfterSec: null });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/made-up-refresh|made-up-client-secret/);
  });

  it("refuses a redirect, an answer with no token and a thrown request, as codes", async () => {
    expect(await refreshGoogleToken("r", client, { transport: async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example.test" } }), log: () => {} })).toMatchObject({ ok: false, code: "redirect_refused" });
    expect(await refreshGoogleToken("r", client, { transport: async () => answer({ token_type: "Bearer" }), log: () => {} })).toMatchObject({ ok: false, code: "bad_response" });
    expect(await refreshGoogleToken("r", client, { transport: async () => Promise.reject(new Error("socket hang up")), log: () => {} })).toMatchObject({ ok: false, code: "network" });
  });

  it("revokes at Google's revoke address, true only on a 200", async () => {
    const transport = vi.fn(async (_url: string, _init: RequestInit) => answer(undefined, 200));
    expect(await revokeGoogleToken("made-up-refresh", { transport, log: () => {} })).toBe(true);
    expect(transport.mock.calls[0]![0]).toBe(GOOGLE_REVOKE_URL);
    expect(String(transport.mock.calls[0]![1].body)).toBe("token=made-up-refresh");
    expect(await revokeGoogleToken("made-up-refresh", { transport: async () => answer({ error: "invalid_token" }, 400), log: () => {} })).toBe(false);
    expect(await revokeGoogleToken("", { transport, log: () => {} })).toBe(false);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
