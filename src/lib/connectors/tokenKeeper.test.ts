import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { changeDataConnection, createDataConnection, forTenant, type TenantContext } from "@/lib/tenant";
import type { RefreshLease } from "@/lib/types/dataConnection";
import { GOOGLE_TOKEN_URL } from "./google";
import { healthyAt } from "./health";
import { ACCESS_SLOT, freshAccessToken, REFRESH_SLOT } from "./tokenKeeper";
import { openConnectorSecret, sealConnectorSecret } from "./vault";

// Google is never called: the token endpoint is a stub transport. Modelled on
// src/lib/social/tokenRefresh.test.ts and src/lib/integrations/tokenRefresh.test.ts.
const A: TenantContext = { tenantId: "ten_a", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const ID = "dcn_aaaaaaaaaaaaaaaaaaaa";
const NOW = new Date("2026-11-21T10:00:00.000Z");
const inMs = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const MIN = 60_000;

const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const GRANTED = { access_token: "made-up-new-access", expires_in: 3599, scope: "https://www.googleapis.com/auth/webmasters.readonly", token_type: "Bearer" };

let db: FakeFirestore;
let transport: ReturnType<typeof vi.fn>;
const deps = (over: Record<string, unknown> = {}) => ({ db, transport, now: NOW, log: () => {}, sleep: async () => {}, ...over });
const sent = (i = 0) => Object.fromEntries(new URLSearchParams(String((transport.mock.calls[i]![1] as RequestInit).body)));
const load = async () => (await forTenant(A, db).dataConnections.getById(ID))!;
const activity = () => db.dump("data_connection_activity").map((a) => `${a.kind}${a.code ? `:${a.code}` : ""}`);

async function seed(over: { expiresAt: string; lease?: RefreshLease; refreshFor?: string } = { expiresAt: inMs(30 * MIN) }) {
  const at = new Date(NOW.getTime() - 60 * MIN);
  await createDataConnection(
    A,
    {
      id: ID,
      connectorId: "search-console",
      method: "oauth_pkce",
      label: "Search Console",
      account: "sc-domain:example.com",
      ownerUid: "usr_admin",
      grants: [],
      secrets: {
        [ACCESS_SLOT]: sealConnectorSecret("ten_a", ID, ACCESS_SLOT, "made-up-old-access", at),
        [REFRESH_SLOT]: sealConnectorSecret("ten_a", over.refreshFor ?? ID, REFRESH_SLOT, "made-up-refresh", at),
      },
      tokenExpiresAt: over.expiresAt,
      refresh: over.lease ?? { leaseId: null, leaseUntil: null },
      health: healthyAt(at),
      pausedAt: null,
      pausedBy: null,
      status: "connected",
      createdAt: at.toISOString(),
      updatedAt: at.toISOString(),
      disconnectedAt: null,
    },
    [{ kind: "connected", by: "usr_admin", at: at.toISOString() }],
    db,
  );
}

const opened = async (slot: string) => {
  const conn = await load();
  return openConnectorSecret("ten_a", ID, slot, conn.secrets[slot]!);
};

beforeEach(() => {
  db = new FakeFirestore();
  transport = vi.fn(async () => answer(GRANTED));
  vi.stubEnv("CONNECTORS_VAULT_KEY", "keeper-test-vault-root-0123456789abcdef0");
  vi.stubEnv("CONNECTOR_GOOGLE_CLIENT_ID", "made-up-client.example.test");
  vi.stubEnv("CONNECTOR_GOOGLE_CLIENT_SECRET", "made-up-client-secret");
});
afterEach(() => vi.unstubAllEnvs());

describe("the token keeper", () => {
  it("hands out the kept token while more than 5 minutes are left, calling nobody", async () => {
    await seed({ expiresAt: inMs(6 * MIN) });
    expect(await freshAccessToken(A, await load(), "usr_admin", deps())).toEqual({ ok: true, token: "made-up-old-access" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("refreshes 5 minutes early, saves the new token sealed, keeps the refresh token when Google sends none, and frees the lease", async () => {
    await seed({ expiresAt: inMs(4 * MIN) });
    const before = (await load()).secrets[REFRESH_SLOT]!.blob.ct;
    expect(await freshAccessToken(A, await load(), "usr_admin", deps())).toEqual({ ok: true, token: "made-up-new-access" });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]![0]).toBe(GOOGLE_TOKEN_URL);
    expect(transport.mock.calls[0]![2]).toEqual({ maxRedirects: 0, allowedPorts: [443], timeoutMs: 10_000 });
    expect(sent()).toEqual({ grant_type: "refresh_token", refresh_token: "made-up-refresh", client_id: "made-up-client.example.test", client_secret: "made-up-client-secret" });
    const conn = await load();
    expect(await opened(ACCESS_SLOT)).toBe("made-up-new-access");
    expect(conn.secrets[REFRESH_SLOT]!.blob.ct).toBe(before);
    expect(conn.tokenExpiresAt).toBe(inMs(3599_000));
    expect(conn.refresh).toEqual({ leaseId: null, leaseUntil: null });
    expect(JSON.stringify(db.raw("data_connections", ID))).not.toContain("made-up-new-access");
    expect(activity()).toEqual(["connected"]);
  });

  it("saves a rotated refresh token, sealed", async () => {
    await seed({ expiresAt: inMs(-MIN) });
    transport.mockResolvedValueOnce(answer({ ...GRANTED, refresh_token: "made-up-rotated-refresh" }));
    expect((await freshAccessToken(A, await load(), "usr_admin", deps())).ok).toBe(true);
    expect(await opened(REFRESH_SLOT)).toBe("made-up-rotated-refresh");
    expect(JSON.stringify(db.raw("data_connections", ID))).not.toContain("made-up-rotated-refresh");
  });

  it("makes one refresh at Google when two callers need one at once", async () => {
    await seed({ expiresAt: inMs(-MIN) });
    const conn = await load();
    const slowSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 2)));
    const [a, b] = await Promise.all([
      freshAccessToken(A, conn, "usr_admin", deps({ sleep: slowSleep })),
      freshAccessToken(A, conn, "usr_admin", deps({ sleep: slowSleep })),
    ]);
    expect(a).toEqual({ ok: true, token: "made-up-new-access" });
    expect(b).toEqual({ ok: true, token: "made-up-new-access" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("lets a caller without the lease use the current token while it still works", async () => {
    await seed({ expiresAt: inMs(3 * MIN), lease: { leaseId: "someone-else", leaseUntil: inMs(20_000) } });
    expect(await freshAccessToken(A, await load(), "usr_admin", deps())).toEqual({ ok: true, token: "made-up-old-access" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("has a caller without the lease and an expired token wait, then say busy when no new token comes", async () => {
    await seed({ expiresAt: inMs(-MIN), lease: { leaseId: "someone-else", leaseUntil: inMs(20_000) } });
    const sleep = vi.fn(async () => {});
    expect(await freshAccessToken(A, await load(), "usr_admin", deps({ sleep }))).toEqual({ ok: false, code: "busy", retryAfterSec: null, recorded: false });
    expect(sleep).toHaveBeenCalledTimes(10);
    expect(transport).not.toHaveBeenCalled();
  });

  it("takes over a lease whose holder died", async () => {
    await seed({ expiresAt: inMs(-MIN), lease: { leaseId: "gone", leaseUntil: inMs(-1000) } });
    expect(await freshAccessToken(A, await load(), "usr_admin", deps())).toEqual({ ok: true, token: "made-up-new-access" });
  });

  it("marks the connection broken with signin_refused when Google says invalid_grant, once", async () => {
    await seed({ expiresAt: inMs(-MIN) });
    transport.mockResolvedValueOnce(answer({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400));
    expect(await freshAccessToken(A, await load(), "agent:vizzy", deps())).toEqual({ ok: false, code: "signin_refused", retryAfterSec: null, recorded: true });
    const conn = await load();
    expect(conn.health).toMatchObject({ state: "broken", lastErrorCode: "signin_refused", failures: 1 });
    expect(conn.refresh).toEqual({ leaseId: null, leaseUntil: null });
    expect(activity()).toEqual(["connected", "failed:signin_refused"]);
    expect(db.dump("data_connection_activity").at(-1)!.by).toBe("agent:vizzy");
  });

  it("reads again before marking: a token another caller saved meanwhile is used instead", async () => {
    await seed({ expiresAt: inMs(-MIN) });
    transport.mockImplementationOnce(async () => {
      await changeDataConnection(
        A,
        ID,
        (cur) => ({ patch: { secrets: { ...cur.secrets, [ACCESS_SLOT]: sealConnectorSecret("ten_a", ID, ACCESS_SLOT, "made-up-other-access", NOW) }, tokenExpiresAt: inMs(59 * MIN) }, activity: [] }),
        db,
      );
      return answer({ error: "invalid_grant" }, 400);
    });
    expect(await freshAccessToken(A, await load(), "usr_admin", deps())).toEqual({ ok: true, token: "made-up-other-access" });
    expect((await load()).health.state).toBe("ok");
    expect(activity()).toEqual(["connected"]);
  });

  it("is soft on a 5xx: the current token is used while it works, and nothing is marked", async () => {
    await seed({ expiresAt: inMs(3 * MIN) });
    transport.mockResolvedValueOnce(answer({ error: "backend_error" }, 503));
    expect(await freshAccessToken(A, await load(), "usr_admin", deps())).toEqual({ ok: true, token: "made-up-old-access" });
    const conn = await load();
    expect(conn.health.state).toBe("ok");
    expect(conn.refresh).toEqual({ leaseId: null, leaseUntil: null });
    expect(activity()).toEqual(["connected"]);
  });

  it("says provider_error on a 5xx once the token has run out, still marking nothing", async () => {
    await seed({ expiresAt: inMs(-MIN) });
    transport.mockResolvedValueOnce(answer({}, 500));
    expect(await freshAccessToken(A, await load(), "usr_admin", deps())).toEqual({ ok: false, code: "provider_error", retryAfterSec: null, recorded: false });
    expect((await load()).health.state).toBe("ok");
    transport.mockRejectedValueOnce(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
    expect(await freshAccessToken(A, await load(), "usr_admin", deps())).toMatchObject({ ok: false, code: "timeout", recorded: false });
  });

  it("treats invalid_client as this copy's setup, not the connection's", async () => {
    await seed({ expiresAt: inMs(-MIN) });
    transport.mockResolvedValueOnce(answer({ error: "invalid_client" }, 401));
    expect(await freshAccessToken(A, await load(), "usr_admin", deps())).toMatchObject({ ok: false, code: "signin_unconfigured", recorded: false });
    expect((await load()).health.state).toBe("ok");
  });

  it("never stores or uses a token for a connection disconnected while it refreshed", async () => {
    await seed({ expiresAt: inMs(-MIN) });
    transport.mockImplementationOnce(async () => {
      await changeDataConnection(A, ID, () => ({ patch: { secrets: {}, status: "disconnected", disconnectedAt: NOW.toISOString() }, activity: [] }), db);
      return answer(GRANTED);
    });
    expect(await freshAccessToken(A, await load(), "usr_admin", deps())).toMatchObject({ ok: false, code: "disconnected" });
    expect((await load()).secrets).toEqual({});
  });

  it("never calls Google with no client or a refresh token that won't open", async () => {
    await seed({ expiresAt: inMs(-MIN), refreshFor: "dcn_bbbbbbbbbbbbbbbbbbbb" });
    expect(await freshAccessToken(A, await load(), "usr_admin", deps())).toMatchObject({ ok: false, code: "secret_unopenable" });
    vi.stubEnv("CONNECTOR_GOOGLE_CLIENT_SECRET", "");
    expect(await freshAccessToken(A, await load(), "usr_admin", deps())).toMatchObject({ ok: false, code: "signin_unconfigured" });
    expect(transport).not.toHaveBeenCalled();
    expect((await load()).refresh).toEqual({ leaseId: null, leaseUntil: null });
  });
});
