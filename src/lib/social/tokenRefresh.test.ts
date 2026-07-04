import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Tenant, SocialConnection } from "@/lib/types/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { encryptToken, decryptToken } from "./crypto";
import {
  refreshSocialToken,
  ensureFreshAccessToken,
  type RefreshablePlatform,
} from "./tokenRefresh";

/**
 * Token refresh: the OAuth refresh exchange + the `ensureFreshAccessToken` gate the
 * Distribute worker calls before every (possibly hours-delayed) send. The publish path
 * itself isn't unit-tested (live fetch), so these prove the refresh/expiry/persist logic
 * in isolation with an injected fetch + clock + persister.
 */

const savedEnv = { ...process.env };
beforeAll(() => {
  process.env.SOCIAL_TOKEN_ENC_KEY = "test-social-root-key-0123456789abcdef";
  process.env.X_OAUTH_CLIENT_ID = "xcid";
  process.env.X_OAUTH_CLIENT_SECRET = "xsecret";
  process.env.LINKEDIN_OAUTH_CLIENT_ID = "licid";
  process.env.LINKEDIN_OAUTH_CLIENT_SECRET = "lisecret";
  process.env.LINKEDIN_CM_CLIENT_ID = "cmcid";
  process.env.LINKEDIN_CM_CLIENT_SECRET = "cmsecret";
});
afterAll(() => {
  process.env = savedEnv;
});

const ctx: TenantContext = { tenantId: "ten_a", region: "us", source: "system" };

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function errStatus(status: number): Response {
  return { ok: false, status, json: async () => ({}) } as unknown as Response;
}

describe("refreshSocialToken", () => {
  it("X: Basic auth + refresh_token grant → returns the rotated bundle", async () => {
    const fetchMock = vi.fn(async () =>
      okJson({ access_token: "new-x-acc", refresh_token: "new-x-ref", expires_in: 7200, scope: "tweet.write" }),
    );
    const res = await refreshSocialToken("x", "old-x-ref", { fetch: fetchMock as unknown as typeof fetch });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.bundle.accessToken).toBe("new-x-acc");
    expect(res.bundle.refreshToken).toBe("new-x-ref");
    expect(res.bundle.expiresAt).not.toBeNull();
    // Grant + confidential-client Basic auth on the wire.
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(call[0])).toContain("api.x.com");
    expect(String(call[1].body)).toContain("grant_type=refresh_token");
    expect(String(call[1].body)).toContain("old-x-ref");
    expect((call[1].headers as Record<string, string>).Authorization).toMatch(/^Basic /);
  });

  it("LinkedIn personal: client_id/secret in the BODY (no Basic auth)", async () => {
    const fetchMock = vi.fn(async () => okJson({ access_token: "new-li", expires_in: 5184000 }));
    const res = await refreshSocialToken("linkedin", "old-li-ref", { fetch: fetchMock as unknown as typeof fetch });
    expect(res.ok && res.bundle.accessToken).toBe("new-li");
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(call[0])).toContain("linkedin.com");
    const body = String(call[1].body);
    expect(body).toContain("client_id=licid");
    expect(body).toContain("client_secret=lisecret");
    expect((call[1].headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("LinkedIn org uses the CM app's credentials (App 2), not the personal app", async () => {
    const fetchMock = vi.fn(async () => okJson({ access_token: "new-cm", expires_in: 5184000 }));
    await refreshSocialToken("linkedin_org", "old-cm-ref", { fetch: fetchMock as unknown as typeof fetch });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = String(call[1].body);
    expect(body).toContain("client_id=cmcid");
    expect(body).toContain("client_secret=cmsecret");
  });

  it("fails soft on a non-2xx (reason carries the status, never throws)", async () => {
    const res = await refreshSocialToken("x", "r", {
      fetch: (async () => errStatus(400)) as unknown as typeof fetch,
    });
    expect(res).toEqual({ ok: false, reason: "x_api_400" });
  });

  it("fails soft on a network error", async () => {
    const res = await refreshSocialToken("x", "r", {
      fetch: (async () => {
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("x_network");
  });

  it("fails when the response omits an access_token", async () => {
    const res = await refreshSocialToken("x", "r", {
      fetch: (async () => okJson({ refresh_token: "only-ref" })) as unknown as typeof fetch,
    });
    expect(res).toEqual({ ok: false, reason: "x_no_token" });
  });

  it("rejects an empty refresh token before any network call", async () => {
    const fetchMock = vi.fn();
    const res = await refreshSocialToken("x", "", { fetch: fetchMock as unknown as typeof fetch });
    expect(res).toEqual({ ok: false, reason: "no_refresh_token" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── ensureFreshAccessToken ───────────────────────────────────────────────────
function tenantWithConn(over: Partial<SocialConnection> = {}, platform: RefreshablePlatform = "x"): Tenant {
  const conn: SocialConnection = {
    platform,
    enc: encryptToken("stored-acc"),
    refreshEnc: encryptToken("stored-ref"),
    handle: "h",
    userId: "u1",
    scope: "s",
    expiresAt: "2026-01-01T00:00:00.000Z",
    connectedAt: "2025-01-01T00:00:00.000Z",
    ...over,
  };
  return { socialConnections: { [platform]: conn } } as unknown as Tenant;
}

const T_EXP = Date.parse("2026-01-01T00:00:00.000Z");

describe("ensureFreshAccessToken", () => {
  it("returns null when the platform isn't connected", async () => {
    expect(await ensureFreshAccessToken(ctx, "x", null)).toBeNull();
    expect(await ensureFreshAccessToken(ctx, "x", {} as Tenant)).toBeNull();
  });

  it("uses the stored token WITHOUT refreshing when it's not near expiry", async () => {
    const persist = vi.fn(async () => {});
    const fetchMock = vi.fn();
    const token = await ensureFreshAccessToken(ctx, "x", tenantWithConn(), {
      now: () => T_EXP - 60 * 60 * 1000, // 1h before expiry (> 5min skew)
      persist,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(token).toBe("stored-acc");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("refreshes + persists the rotated token when within the expiry skew", async () => {
    const persisted: SocialConnection[] = [];
    const token = await ensureFreshAccessToken(ctx, "x", tenantWithConn(), {
      now: () => T_EXP - 60 * 1000, // 1min before expiry (< 5min skew)
      fetch: (async () =>
        okJson({ access_token: "fresh-acc", refresh_token: "fresh-ref", expires_in: 7200 })) as unknown as typeof fetch,
      persist: async (_p, c) => void persisted.push(c),
    });
    expect(token).toBe("fresh-acc");
    expect(persisted).toHaveLength(1);
    // The persisted connection carries the NEW encrypted tokens + a fresh expiry.
    expect(decryptToken(persisted[0]!.enc)).toBe("fresh-acc");
    expect(decryptToken(persisted[0]!.refreshEnc!)).toBe("fresh-ref");
    expect(persisted[0]!.expiresAt).not.toBe("2026-01-01T00:00:00.000Z");
    // Non-token fields are preserved.
    expect(persisted[0]!.handle).toBe("h");
    expect(persisted[0]!.userId).toBe("u1");
  });

  it("also refreshes an ALREADY-expired token (the +24/48h follow-up job case)", async () => {
    const token = await ensureFreshAccessToken(ctx, "x", tenantWithConn(), {
      now: () => T_EXP + 48 * 60 * 60 * 1000, // 48h past expiry
      fetch: (async () => okJson({ access_token: "fresh-acc", expires_in: 7200 })) as unknown as typeof fetch,
      persist: async () => {},
    });
    expect(token).toBe("fresh-acc");
  });

  it("fail-soft: returns the stored (expiring) token when the refresh call fails", async () => {
    const persist = vi.fn(async () => {});
    const token = await ensureFreshAccessToken(ctx, "x", tenantWithConn(), {
      now: () => T_EXP - 60 * 1000,
      fetch: (async () => errStatus(400)) as unknown as typeof fetch,
      persist,
    });
    expect(token).toBe("stored-acc");
    expect(persist).not.toHaveBeenCalled(); // nothing to persist on failure
  });

  it("keeps the prior refresh token when the platform doesn't rotate one", async () => {
    const persisted: SocialConnection[] = [];
    await ensureFreshAccessToken(ctx, "x", tenantWithConn(), {
      now: () => T_EXP - 60 * 1000,
      fetch: (async () => okJson({ access_token: "fresh-acc", expires_in: 7200 })) as unknown as typeof fetch, // no refresh_token
      persist: async (_p, c) => void persisted.push(c),
    });
    expect(decryptToken(persisted[0]!.refreshEnc!)).toBe("stored-ref"); // unchanged
  });

  it("self-heals a MALFORMED stored expiry by refreshing (never skip-forever)", async () => {
    // A non-ISO expiresAt (corrupt data) must be treated as expired → refresh, not
    // silently treated like a null expiry and skipped on every run.
    const persisted: SocialConnection[] = [];
    const token = await ensureFreshAccessToken(ctx, "x", tenantWithConn({ expiresAt: "not-a-date" }), {
      now: () => T_EXP,
      fetch: (async () => okJson({ access_token: "healed-acc", expires_in: 7200 })) as unknown as typeof fetch,
      persist: async (_p, c) => void persisted.push(c),
    });
    expect(token).toBe("healed-acc");
    expect(persisted).toHaveLength(1);
  });

  it("persists a NULL expiry (not the stale past one) when the refresh omits expires_in", async () => {
    // Reusing the old past expiry would force a re-refresh on the very next run (churn).
    const persisted: SocialConnection[] = [];
    await ensureFreshAccessToken(ctx, "x", tenantWithConn(), {
      now: () => T_EXP - 60 * 1000,
      fetch: (async () => okJson({ access_token: "fresh-acc" })) as unknown as typeof fetch, // no expires_in
      persist: async (_p, c) => void persisted.push(c),
    });
    expect(persisted[0]!.expiresAt).toBeNull();
  });

  it("does NOT refresh when there's no refresh token to spend", async () => {
    const fetchMock = vi.fn();
    const token = await ensureFreshAccessToken(ctx, "x", tenantWithConn({ refreshEnc: null }), {
      now: () => T_EXP - 60 * 1000,
      fetch: fetchMock as unknown as typeof fetch,
      persist: async () => {},
    });
    expect(token).toBe("stored-acc");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the stored token when no expiry is recorded (nothing to compare)", async () => {
    const fetchMock = vi.fn();
    const token = await ensureFreshAccessToken(ctx, "x", tenantWithConn({ expiresAt: null }), {
      now: () => T_EXP,
      fetch: fetchMock as unknown as typeof fetch,
      persist: async () => {},
    });
    expect(token).toBe("stored-acc");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still returns the fresh token even if persistence fails", async () => {
    const token = await ensureFreshAccessToken(ctx, "x", tenantWithConn(), {
      now: () => T_EXP - 60 * 1000,
      fetch: (async () => okJson({ access_token: "fresh-acc", expires_in: 7200 })) as unknown as typeof fetch,
      persist: async () => {
        throw new Error("firestore down");
      },
    });
    expect(token).toBe("fresh-acc");
  });
});
