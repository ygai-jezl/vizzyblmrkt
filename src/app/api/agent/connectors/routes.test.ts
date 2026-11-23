import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { __resetRateLimitState } from "@/lib/tenant/rateLimit";
import { createDataConnection, type TenantContext } from "@/lib/tenant";
import { numberKeys } from "@/lib/metrics/meanings";
import { sealConnectorSecret } from "@/lib/connectors/vault";
import type { ConnectionGrant } from "@/lib/types/dataConnection";

// Vizzy's connector routes, modelled on src/app/api/agent/results/routes.test.ts: switch, token,
// rate limit, then input; the brand comes from the token only; reads need the agent:vizzy grant
// (and the members grant when reading for a member); every number in an answer has a meaning.
// Cloudflare is never called: the global fetch that src/lib/security/ssrf.ts uses is a stub.
const auth = vi.hoisted(() => ({ isCanvasAuthConfigured: vi.fn(() => true), verifyCanvasContext: vi.fn(), tenantContextFromCanvasToken: vi.fn() }));
vi.mock("@/lib/canvas/auth", () => auth);
const store = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => store.db,
}));

const list = await import("./route");
const live = await import("./live/route");

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "agent", userId: "usr_admin", role: "admin" };
const B: TenantContext = { tenantId: "ten_B", region: "us", source: "agent", userId: "usr_b", role: "admin" };
const ZONE = "0123456789abcdef0123456789abcdef";
const SHARED = "dcn_aaaaaaaaaaaaaaaaaaaa";
const PRIVATE = "dcn_bbbbbbbbbbbbbbbbbbbb";
const THEIRS = "dcn_cccccccccccccccccccc";
const T0 = "2026-11-20T10:00:00.000Z";
const DAILY = {
  data: {
    viewer: {
      zones: [
        {
          daily: [{ dimensions: { date: "2026-11-19" }, sum: { requests: 2600, pageViews: 330 }, uniq: { uniques: 95 } }],
          traffic: [{ dimensions: { date: "2026-11-19" }, count: 2400, sum: { visits: 140 } }],
          pages: [{ dimensions: { date: "2026-11-19" }, count: 310 }],
        },
      ],
    },
  },
  errors: null,
};

let db: FakeFirestore;
let fetchMock: ReturnType<typeof vi.fn>;
const claims = (role: string) => ({ ok: true, claims: { tenantId: "ten_A", region: "us", userId: "usr_x", role, jti: "j", iat: 0, exp: 9e9 } });

const get = () => list.GET(new Request("http://localhost/api/agent/connectors?tenantId=ten_B", { headers: { "x-canvas-context": "tok" } }));
const post = (body: unknown) =>
  live.POST(new Request("http://localhost/api/agent/connectors/live", { method: "POST", headers: { "x-canvas-context": "tok", "content-type": "application/json" }, body: JSON.stringify(body) }));
const read = (over: Record<string, unknown> = {}) => post({ connectionId: SHARED, stream: "zone_daily", from: "2026-11-19", to: "2026-11-19", ...over });

async function seed(ctx: TenantContext, id: string, grants: ConnectionGrant[]) {
  await createDataConnection(
    ctx,
    {
      id,
      connectorId: "cloudflare",
      method: "token_fields",
      label: `Cloudflare ${id.slice(-4)}`,
      account: ZONE,
      ownerUid: "usr_admin",
      grants,
      secrets: { token: sealConnectorSecret(ctx.tenantId, id, "token", "made-up-cloudflare-token-0000000000") },
      health: { state: "ok", lastOkAt: T0, lastCheckedAt: T0, lastErrorCode: null, failures: 0, pausedUntil: null },
      pausedAt: null,
      pausedBy: null,
      status: "connected",
      createdAt: T0,
      updatedAt: T0,
      disconnectedAt: null,
    },
    [{ kind: "connected", by: "usr_admin", at: T0 }],
    db,
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  __resetRateLimitState();
  db = new FakeFirestore();
  store.db = db;
  fetchMock = vi.fn(async () => new Response(JSON.stringify(DAILY), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("CONNECTORS_ENABLED", "true");
  vi.stubEnv("CONNECTORS_CHAT_ENABLED", "true");
  vi.stubEnv("CONNECTOR_CLOUDFLARE_ENABLED", "true");
  vi.stubEnv("CONNECTORS_VAULT_KEY", "agent-route-test-vault-root-0123456789ab");
  auth.isCanvasAuthConfigured.mockReturnValue(true);
  auth.verifyCanvasContext.mockReturnValue(claims("admin"));
  auth.tenantContextFromCanvasToken.mockReturnValue(A);
  await seed(A, SHARED, [{ to: "agent:vizzy", can: "read" }]);
  await seed(A, PRIVATE, []);
  await seed(B, THEIRS, [{ to: "agent:vizzy", can: "read" }, { to: "members", can: "read" }]);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("/api/agent/connectors", () => {
  it("is unavailable while either switch is off, before reading the token", async () => {
    vi.stubEnv("CONNECTORS_CHAT_ENABLED", "");
    expect((await get()).status).toBe(503);
    expect((await read()).status).toBe(503);
    vi.stubEnv("CONNECTORS_CHAT_ENABLED", "true");
    vi.stubEnv("CONNECTORS_ENABLED", "false");
    expect((await get()).status).toBe(503);
    expect(auth.verifyCanvasContext).not.toHaveBeenCalled();
    auth.isCanvasAuthConfigured.mockReturnValue(false);
    vi.stubEnv("CONNECTORS_ENABLED", "true");
    expect(await (await get()).json()).toEqual({ error: "canvas_auth_unconfigured" });
  });

  it("401s a bad token and 429s past the rate limit", async () => {
    auth.verifyCanvasContext.mockReturnValue({ ok: false, error: "expired" });
    expect((await get()).status).toBe(401);
    expect((await read()).status).toBe(401);
    auth.verifyCanvasContext.mockReturnValue(claims("admin"));
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await get()).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("400s bad input, including a brand in the body", async () => {
    expect((await post({ connectionId: "nope", stream: "zone_daily", from: "2026-11-19", to: "2026-11-19" })).status).toBe(400);
    expect((await read({ tenantId: "ten_B" })).status).toBe(400);
    expect((await read({ limit: 500 })).status).toBe(400);
    expect((await read({ from: "yesterday" })).status).toBe(400);
    expect((await read({ from: "2026-01-01", to: "2026-11-19" })).status).toBe(400);
    expect((await read({ period: "last_28_days" })).status).toBe(400);
    expect((await read({ from: undefined, to: undefined, period: "last_week" })).status).toBe(400);
    expect((await read({ page: "/pricing" })).status).toBe(400);
    expect((await live.POST(new Request("http://localhost/api/agent/connectors/live", { method: "POST", headers: { "x-canvas-context": "tok" }, body: "not json" }))).status).toBe(400);
  });

  it("lists only what Vizzy may read, from the token's brand, saying others aren't shared", async () => {
    const body = await (await get()).json();
    expect(body.connections.map((c: { id: string }) => c.id)).toEqual([SHARED]);
    expect(body.notShared).toBe(true);
    expect(body.connections[0]).toMatchObject({ connector: "Cloudflare", health: "ok", canRead: true, streams: [{ stream: "zone_daily", by: ["day"], pageFilter: false }] });
    expect(body.connections[0].streams[0].days).toContain("UTC");
    expect(Object.keys(body.meanings)).toEqual(["cfRequests", "cfPageViews", "cfVisits", "cfUniqueVisitors"]);
    expect(JSON.stringify(body)).not.toContain("made-up-cloudflare-token");
    expect(JSON.stringify(body)).not.toContain(THEIRS);
  });

  it("reads live with the grant, every number with its meaning, and logs it off the recent list", async () => {
    const res = await read();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows).toEqual([{ day: "2026-11-19", cfRequests: 2400, cfPageViews: 310, cfVisits: 140, cfUniqueVisitors: 95 }]);
    for (const k of numberKeys(body)) expect(Object.keys(body.meanings), k).toContain(k);
    expect(body.connection).toEqual({ id: SHARED, connectorId: "cloudflare", connector: "Cloudflare", label: `Cloudflare ${SHARED.slice(-4)}` });
    expect(body.period).toMatchObject({ from: "2026-11-19", to: "2026-11-19", timeZone: "UTC", words: "19 Nov 2026, UTC" });
    expect(body.more).toBe(false);
    expect(body).not.toHaveProperty("lag");
    const rows = db.dump("data_connection_activity").filter((a) => a.connectionId === SHARED).map((a) => `${a.kind}:${a.by}`);
    expect(rows).toContain("read:agent:vizzy");
    expect((db.raw("data_connections", SHARED) as { recent: Array<{ kind: string }> }).recent.map((r) => r.kind)).toEqual(["connected"]);
  });

  it("403s without the agent grant, and for a member without the members grant", async () => {
    const no = await read({ connectionId: PRIVATE });
    expect(no.status).toBe(403);
    expect(await no.json()).toMatchObject({ error: "no_agent_grant" });
    auth.verifyCanvasContext.mockReturnValue(claims("member"));
    const member = await read();
    expect(member.status).toBe(403);
    expect(await member.json()).toMatchObject({ error: "no_read_grant" });
    const listed = await (await get()).json();
    expect(listed.connections[0]).toMatchObject({ canRead: false });
    expect(listed.connections[0].cannotReadBecause).toContain("Members aren't allowed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never reads another brand's connection, whatever the body names", async () => {
    const res = await read({ connectionId: THEIRS });
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
