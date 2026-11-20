import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Revoking social tokens at the platform. X only with both switches on, the refresh
// token first and then the access token; LinkedIn and LinkedIn Pages never. Best effort:
// never throws, gives up after 8 seconds, never logs a token.
const tenant = vi.hoisted(() => ({ getTenantById: vi.fn() }));
vi.mock("@/lib/tenant", () => tenant);

const { X_REVOKE_URL, revokeSocialConnection, storedSocialTokens } = await import("./revoke");
const { encryptToken } = await import("./crypto");

const TOKENS = { accessToken: "x-access", refreshToken: "x-refresh" };
let fetchMock: ReturnType<typeof vi.fn>;
const deps = () => ({ fetch: fetchMock as unknown as typeof fetch });
const calls = () => fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
const bodyOf = (i: number) => Object.fromEntries(new URLSearchParams(String(calls()[i]![1].body)));
let warn: ReturnType<typeof vi.spyOn>;
const logged = () => warn.mock.calls.map((c) => c.join(" ")).join("\n");
const both = () => {
  vi.stubEnv("CONNECTOR_REVOKE_ENABLED", "true");
  vi.stubEnv("CONNECTOR_REVOKE_X_ENABLED", "true");
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SOCIAL_TOKEN_ENC_KEY", "unit-test-social-root-key-please-rotate");
  vi.stubEnv("X_OAUTH_CLIENT_ID", "x-test-client");
  vi.stubEnv("X_OAUTH_CLIENT_SECRET", "x-test-secret");
  vi.stubEnv("CONNECTOR_REVOKE_ENABLED", "");
  vi.stubEnv("CONNECTOR_REVOKE_X_ENABLED", "");
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ revoked: true }), { status: 200 }));
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  warn.mockRestore();
});

describe("revokeSocialConnection: X", () => {
  it("both switches on: revokes the refresh token, then the access token, with Basic client auth", async () => {
    both();
    expect(await revokeSocialConnection("ten_A", "x", TOKENS, deps())).toEqual({ result: "done" });
    expect(calls()).toHaveLength(2);
    for (const [url, init] of calls()) {
      expect(url).toBe("https://api.x.com/2/oauth2/revoke");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>).Authorization).toBe(
        `Basic ${Buffer.from("x-test-client:x-test-secret").toString("base64")}`,
      );
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(X_REVOKE_URL).toBe("https://api.x.com/2/oauth2/revoke");
    expect(bodyOf(0)).toEqual({ token: "x-refresh", token_type_hint: "refresh_token", client_id: "x-test-client" });
    expect(bodyOf(1)).toEqual({ token: "x-access", token_type_hint: "access_token", client_id: "x-test-client" });
  });

  it("with no refresh token, revokes the access token only", async () => {
    both();
    await revokeSocialConnection("ten_A", "x", { accessToken: "x-access", refreshToken: null }, deps());
    expect(calls()).toHaveLength(1);
    expect(bodyOf(0)).toMatchObject({ token: "x-access", token_type_hint: "access_token" });
  });

  it("the revoke switch on and the X switch off: skipped, no call", async () => {
    vi.stubEnv("CONNECTOR_REVOKE_ENABLED", "true");
    expect(await revokeSocialConnection("ten_A", "x", TOKENS, deps())).toEqual({ result: "skipped", reason: "x_switch_off" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("both switches off: skipped, no call", async () => {
    expect(await revokeSocialConnection("ten_A", "x", TOKENS, deps())).toMatchObject({ result: "skipped" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the X switch alone: skipped, no call", async () => {
    vi.stubEnv("CONNECTOR_REVOKE_X_ENABLED", "true");
    expect(await revokeSocialConnection("ten_A", "x", TOKENS, deps())).toMatchObject({ result: "skipped" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips with no tokens, or with X not set up", async () => {
    both();
    expect(await revokeSocialConnection("ten_A", "x", null, deps())).toEqual({ result: "skipped", reason: "not_connected" });
    vi.stubEnv("X_OAUTH_CLIENT_SECRET", "");
    expect(await revokeSocialConnection("ten_A", "x", TOKENS, deps())).toEqual({ result: "skipped", reason: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("revokeSocialConnection: LinkedIn is never revoked", () => {
  it.each(["linkedin", "linkedin_org"] as const)("%s with both switches on: skipped, no call", async (platform) => {
    both();
    expect(await revokeSocialConnection("ten_A", platform, TOKENS, deps())).toEqual({
      result: "skipped",
      reason: "linkedin_policy",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("revokeSocialConnection: failures never throw", () => {
  beforeEach(both);

  it("a refused revoke is failed, still tries the access token, and logs no token", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 400 }));
    expect(await revokeSocialConnection("ten_A", "x", TOKENS, deps())).toEqual({
      result: "failed",
      reason: "refresh_token:api_400",
    });
    expect(calls()).toHaveLength(2);
    expect(logged()).toContain("[revoke] x revoke failed for ten_A: refresh_token:api_400");
    expect(logged()).not.toMatch(/x-access|x-refresh|x-test-secret/);
  });

  it("a network error is failed", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed x-refresh"));
    const res = await revokeSocialConnection("ten_A", "x", TOKENS, deps());
    expect(res).toEqual({ result: "failed", reason: "refresh_token:network:TypeError,access_token:network:TypeError" });
    expect(logged()).not.toMatch(/x-access|x-refresh/);
  });

  it("gives up after the timeout, for both calls together", async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init.signal!;
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    const res = await revokeSocialConnection("ten_A", "x", TOKENS, { ...deps(), timeoutMs: 5 });
    expect(res).toEqual({ result: "failed", reason: "refresh_token:timeout,access_token:timeout" });
  });

  it("a fetch that throws straight away is failed", async () => {
    const throwing = (() => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    expect(await revokeSocialConnection("ten_A", "x", TOKENS, { fetch: throwing })).toMatchObject({ result: "failed" });
  });
});

describe("storedSocialTokens", () => {
  it("reads this brand's tokens before a Disconnect deletes them", async () => {
    tenant.getTenantById.mockResolvedValue({
      socialConnections: {
        x: { platform: "x", enc: encryptToken("x-access"), refreshEnc: encryptToken("x-refresh"), connectedAt: "2026-11-01T00:00:00.000Z" },
      },
    });
    expect(await storedSocialTokens("ten_A", "x")).toEqual(TOKENS);
    expect(tenant.getTenantById).toHaveBeenCalledWith("ten_A");
  });

  it("is null when not connected, unreadable, or the read fails", async () => {
    tenant.getTenantById.mockResolvedValueOnce({ socialConnections: {} });
    expect(await storedSocialTokens("ten_A", "x")).toBeNull();
    tenant.getTenantById.mockResolvedValueOnce({
      socialConnections: { x: { platform: "x", enc: { ct: "x", iv: "x", tag: "x" }, connectedAt: "2026-11-01T00:00:00.000Z" } },
    });
    expect(await storedSocialTokens("ten_A", "x")).toBeNull();
    tenant.getTenantById.mockRejectedValueOnce(new Error("unavailable"));
    expect(await storedSocialTokens("ten_A", "x")).toBeNull();
  });
});
