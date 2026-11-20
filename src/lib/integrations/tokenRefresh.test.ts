import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { getTenantById } from "@/lib/tenant/registry";
import { deleteTenantGitConnection, swapTenantGitToken } from "@/lib/tenant/control";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { GitConnection } from "@/lib/types/tenant";
import { decryptToken, encryptToken, gitRefreshAad } from "./crypto";
import {
  WORKER_MIN_VALIDITY_MS,
  ensureFreshGitToken,
  prepareGitTokenForWorker,
  refreshGitLabToken,
} from "./tokenRefresh";

// deleteTenantGitConnection (a Disconnect) reads the database from getDb.
const store = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => store.db,
}));

// GitLab access tokens last 2 hours. The app refreshes before each use, with
// compare-and-set writes, and only a refused refresh marks the connection.
const ORIGIN = "https://yougrow.test";
const ctx = { tenantId: "ten_A", region: "us" } as TenantContext;
const NOW = Date.parse("2026-11-20T10:00:00.000Z");
const MIN = 60_000;
const at = (ms: number) => new Date(ms).toISOString();
const AAD = gitRefreshAad("ten_A", "gitlab");

const tenantDoc = (gitConnections: Record<string, unknown>) => ({
  tenantName: "Example Co",
  rootDomain: "example.com",
  status: "active",
  region: "us",
  allowedOrigins: ["https://example.com"],
  billingTier: "mvp_free",
  ownerId: "usr_owner",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  gitConnections,
});

function gitlabConn(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: "gitlab",
    kind: "oauth",
    enc: encryptToken("gl-old-access"),
    refreshEnc: encryptToken("gl-old-refresh", AAD),
    expiresAt: at(NOW + 2 * MIN),
    accountLogin: "acme-dev",
    connectedAt: at(NOW - 118 * MIN),
    repos: [],
    ...over,
  };
}

async function world(conn: Record<string, unknown> = gitlabConn(), provider: "github" | "gitlab" = "gitlab") {
  const db = new FakeFirestore();
  store.db = db;
  db.seed("tenants", "ten_A", tenantDoc({ [provider]: conn }));
  const read = async () => (await getTenantById("ten_A", db))?.gitConnections?.[provider];
  return { db, conn: (await read()) as GitConnection, read };
}

const tokenResponse = (body: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({ access_token: "gl-new-access", refresh_token: "gl-new-refresh", expires_in: 7200, ...body }),
    { status: 200 },
  );
let fetchMock: ReturnType<typeof vi.fn>;
const doFetch = () => fetchMock as unknown as typeof fetch;
const sentBody = () => new URLSearchParams(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubEnv("GIT_TOKEN_ENC_KEY", "unit-test-root-key-please-rotate");
  vi.stubEnv("GITLAB_OAUTH_CLIENT_ID", "gitlab-test-client");
  vi.stubEnv("GITLAB_OAUTH_CLIENT_SECRET", "gitlab-test-secret");
  vi.stubEnv("GIT_OAUTH_ORIGIN", ORIGIN);
  fetchMock = vi.fn(async () => tokenResponse());
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  // No log line ever carries a token.
  const logged = warn.mock.calls.flat().map(String).join("\n");
  expect(logged).not.toMatch(/gl-(old|new)-(access|refresh)|gitlab-test-secret/);
  warn.mockRestore();
  vi.unstubAllEnvs();
});

describe("refreshGitLabToken", () => {
  it("posts the refresh grant with the pinned callback as redirect_uri", async () => {
    const r = await refreshGitLabToken("gl-old-refresh", { fetch: doFetch(), now: () => NOW });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://gitlab.com/oauth/token");
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(Object.fromEntries(sentBody())).toEqual({
      grant_type: "refresh_token",
      refresh_token: "gl-old-refresh",
      client_id: "gitlab-test-client",
      client_secret: "gitlab-test-secret",
      redirect_uri: `${ORIGIN}/api/admin/integrations/gitlab/callback`,
    });
    expect(r).toEqual({
      ok: true,
      bundle: { accessToken: "gl-new-access", refreshToken: "gl-new-refresh", expiresAt: at(NOW + 7200 * 1000) },
    });
  });

  it("leaves redirect_uri out when no origin is pinned", async () => {
    vi.stubEnv("GIT_OAUTH_ORIGIN", "");
    await refreshGitLabToken("gl-old-refresh", { fetch: doFetch() });
    expect(sentBody().has("redirect_uri")).toBe(false);
  });

  it("doesn't call GitLab when the app isn't configured", async () => {
    vi.stubEnv("GITLAB_OAUTH_CLIENT_SECRET", "");
    expect(await refreshGitLabToken("gl-old-refresh", { fetch: doFetch() })).toEqual({ ok: false, reason: "gitlab_not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports the status of a refused refresh", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 400 }));
    expect(await refreshGitLabToken("gl-old-refresh", { fetch: doFetch() })).toEqual({ ok: false, reason: "api_400", status: 400 });
  });
});

describe("ensureFreshGitToken", () => {
  const opts = (db: FakeFirestore, over: Record<string, unknown> = {}) => ({
    db: db as unknown as FirestoreLike,
    fetch: doFetch(),
    now: () => NOW,
    ...over,
  });

  it("uses the stored token as it is when it isn't due", async () => {
    const { db, conn } = await world(gitlabConn({ expiresAt: at(NOW + 60 * MIN) }));
    const r = await ensureFreshGitToken(ctx, "gitlab", conn, opts(db));
    expect(r).toEqual({ token: "gl-old-access", ct: conn.enc!.ct, reconnect: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes a token about to expire and stores it with compare-and-set", async () => {
    const { db, conn, read } = await world(gitlabConn({ reconnect: { at: at(NOW - MIN), reason: "provider_rejected" } }));
    const r = await ensureFreshGitToken(ctx, "gitlab", conn, opts(db));
    const stored = (await read())!;
    expect(r).toEqual({ token: "gl-new-access", ct: stored.enc!.ct, reconnect: false });
    expect(decryptToken(stored.enc!)).toBe("gl-new-access");
    expect(decryptToken(stored.refreshEnc!, AAD)).toBe("gl-new-refresh");
    expect(stored.expiresAt).toBe(at(NOW + 7200 * 1000));
    expect(stored.reconnect).toBeUndefined();
    expect(stored.connectedAt).toBe(conn.connectedAt);
    expect(sentBody().get("refresh_token")).toBe("gl-old-refresh");
  });

  it("keeps the stored refresh token when GitLab doesn't rotate it", async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse({ refresh_token: undefined }));
    const { db, conn, read } = await world();
    await ensureFreshGitToken(ctx, "gitlab", conn, opts(db));
    expect(decryptToken((await read())!.refreshEnc!, AAD)).toBe("gl-old-refresh");
  });

  it.each([
    ["missing", null],
    ["unreadable", "not a date"],
  ])("refreshes when the expiry is %s", async (_label, expiresAt) => {
    const { db, conn } = await world(gitlabConn({ expiresAt }));
    expect((await ensureFreshGitToken(ctx, "gitlab", conn, opts(db))).token).toBe("gl-new-access");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("with the worker's 90 minute margin, refreshes with 80 minutes left and not with 100", async () => {
    const soon = await world(gitlabConn({ expiresAt: at(NOW + 80 * MIN) }));
    const r80 = await ensureFreshGitToken(ctx, "gitlab", soon.conn, opts(soon.db, { minValidityMs: WORKER_MIN_VALIDITY_MS }));
    expect(r80.token).toBe("gl-new-access");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const later = await world(gitlabConn({ expiresAt: at(NOW + 100 * MIN) }));
    const r100 = await ensureFreshGitToken(ctx, "gitlab", later.conn, opts(later.db, { minValidityMs: WORKER_MIN_VALIDITY_MS }));
    expect(r100.token).toBe("gl-old-access");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the stored token when another request stored a newer one first", async () => {
    const { db, conn, read } = await world();
    const racer = encryptToken("gl-racer-access");
    db.onBeforeCommit = async () => {
      await swapTenantGitToken("ten_A", "gitlab", conn.enc!.ct, { enc: racer, refreshEnc: null, expiresAt: at(NOW + 120 * MIN) }, db);
    };
    const r = await ensureFreshGitToken(ctx, "gitlab", conn, opts(db));
    expect(r).toEqual({ token: "gl-racer-access", ct: racer.ct, reconnect: false });
    expect((await read())!.enc).toEqual(racer);
  });

  it("never stores or uses a token for a connection removed meanwhile", async () => {
    const { db, conn, read } = await world();
    db.onBeforeCommit = () => deleteTenantGitConnection("ten_A", "gitlab");
    const r = await ensureFreshGitToken(ctx, "gitlab", conn, opts(db));
    expect(r).toEqual({ token: null, ct: null, reconnect: false });
    expect(await read()).toBeUndefined();
    expect(await getTenantById("ten_A", db)).not.toBeNull();
  });

  it.each([400, 401])("a refused refresh (%i) marks the connection and returns the old token", async (status) => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "invalid_grant" }), { status }));
    const { db, conn, read } = await world();
    const r = await ensureFreshGitToken(ctx, "gitlab", conn, opts(db));
    expect(r).toEqual({ token: "gl-old-access", ct: conn.enc!.ct, reconnect: true });
    const stored = (await read())!;
    expect(stored.reconnect?.reason).toBe("refresh_failed");
    expect(stored.enc).toEqual(conn.enc);
  });

  it("a refusal after another request's refresh uses the stored token and doesn't mark", async () => {
    const { db, conn, read } = await world();
    const racer = encryptToken("gl-racer-access");
    // The other request spent the refresh token first, so ours is refused.
    fetchMock.mockImplementationOnce(async () => {
      await swapTenantGitToken("ten_A", "gitlab", conn.enc!.ct, { enc: racer, refreshEnc: null, expiresAt: at(NOW + 120 * MIN) }, db);
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    });
    const r = await ensureFreshGitToken(ctx, "gitlab", conn, opts(db));
    expect(r).toEqual({ token: "gl-racer-access", ct: racer.ct, reconnect: false });
    expect((await read())!.reconnect).toBeUndefined();
  });

  it.each([
    ["a network error", () => Promise.reject(new TypeError("fetch failed"))],
    ["a 5xx", async () => new Response("bad gateway", { status: 502 })],
    ["a 429", async () => new Response("slow down", { status: 429 })],
  ])("%s keeps the old token with no mark, and says it may be stale", async (_label, reply) => {
    fetchMock.mockImplementationOnce(reply);
    const { db, conn, read } = await world();
    const r = await ensureFreshGitToken(ctx, "gitlab", conn, opts(db));
    expect(r).toEqual({ token: "gl-old-access", ct: conn.enc!.ct, reconnect: false, stale: true });
    expect((await read())!.reconnect).toBeUndefined();
  });

  it("a refresh token that only opens on another brand is treated as refused", async () => {
    const { db, conn, read } = await world(gitlabConn({ refreshEnc: encryptToken("gl-old-refresh", gitRefreshAad("ten_B", "gitlab")) }));
    const r = await ensureFreshGitToken(ctx, "gitlab", conn, opts(db));
    expect(r.reconnect).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await read())!.reconnect?.reason).toBe("refresh_failed");
  });

  it("an older GitLab connection with no refresh token is used as it is", async () => {
    const { db, conn } = await world(gitlabConn({ refreshEnc: undefined, expiresAt: undefined }));
    expect(await ensureFreshGitToken(ctx, "gitlab", conn, opts(db))).toEqual({ token: "gl-old-access", ct: conn.enc!.ct, reconnect: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never refreshes classic GitHub", async () => {
    const { db, conn } = await world({ provider: "github", kind: "oauth", enc: encryptToken("gh-classic"), connectedAt: at(NOW - 1000 * MIN) }, "github");
    expect(await ensureFreshGitToken(ctx, "github", conn, opts(db))).toEqual({ token: "gh-classic", ct: conn.enc!.ct, reconnect: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives no token for a GitHub App connection or none at all", async () => {
    const app = { provider: "github", kind: "app", installationId: 7, connectedAt: at(NOW) } as GitConnection;
    expect(await ensureFreshGitToken(ctx, "github", app, { fetch: doFetch() })).toEqual({ token: null, ct: null, reconnect: false });
    expect(await ensureFreshGitToken(ctx, "gitlab", undefined, { fetch: doFetch() })).toEqual({ token: null, ct: null, reconnect: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a stored token that won't open gives none and says reconnect", async () => {
    const { db, conn } = await world(gitlabConn({ enc: { ct: "x", iv: "x", tag: "x" } }));
    expect(await ensureFreshGitToken(ctx, "gitlab", conn, opts(db))).toEqual({ token: null, ct: "x", reconnect: true });
  });

  it("never throws, even when the database fails", async () => {
    const { conn } = await world();
    const broken = {
      collection: () => {
        throw new Error("unavailable");
      },
      runTransaction: async () => {
        throw new Error("unavailable");
      },
    } as unknown as FirestoreLike;
    const r = await ensureFreshGitToken(ctx, "gitlab", conn, { db: broken, fetch: doFetch(), now: () => NOW });
    expect(r.token).toBe("gl-new-access");
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 400 }));
    const refused = await ensureFreshGitToken(ctx, "gitlab", conn, { db: broken, fetch: doFetch(), now: () => NOW });
    expect(refused).toEqual({ token: "gl-old-access", ct: conn.enc!.ct, reconnect: false });
  });
});

describe("prepareGitTokenForWorker", () => {
  it("refreshes a stored token with less than 90 minutes left", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    try {
      vi.stubGlobal("fetch", fetchMock);
      const { db, read } = await world(gitlabConn({ expiresAt: at(NOW + 80 * MIN) }));
      await prepareGitTokenForWorker(ctx, "gitlab", { db: db as unknown as FirestoreLike });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(decryptToken((await read())!.enc!)).toBe("gl-new-access");
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("leaves a token with more than 90 minutes alone", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    try {
      vi.stubGlobal("fetch", fetchMock);
      const { db } = await world(gitlabConn({ expiresAt: at(NOW + 100 * MIN) }));
      await prepareGitTokenForWorker(ctx, "gitlab", { db: db as unknown as FirestoreLike });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("swallows everything", async () => {
    const broken = {
      collection: () => {
        throw new Error("unavailable");
      },
    } as unknown as FirestoreLike;
    await expect(prepareGitTokenForWorker(ctx, "gitlab", { db: broken })).resolves.toBeUndefined();
    const empty = new FakeFirestore() as unknown as FirestoreLike;
    await expect(prepareGitTokenForWorker(ctx, "gitlab", { db: empty })).resolves.toBeUndefined();
  });
});
