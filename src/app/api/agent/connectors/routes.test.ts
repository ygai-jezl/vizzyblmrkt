import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { __resetRateLimitState } from "@/lib/tenant/rateLimit";
import { createDataConnection, type TenantContext } from "@/lib/tenant";
import { MEANINGS, numberKeys, shownMeaning } from "@/lib/metrics/meanings";
import { sealConnectorSecret } from "@/lib/connectors/vault";
import { CONNECTORS_AGENT_LIMIT, CONNECTORS_NUMBERS_LIMIT } from "@/lib/connectors/agentGate";
import { addDays } from "@/lib/connectors/period";
import { rollConnection } from "@/lib/connectors/rollups";
import { writeDayDoc } from "@/lib/connectors/snapshots";
import { CollectStateSchema, type ConnectionGrant, type DataConnection } from "@/lib/types/dataConnection";

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
const numbers = await import("./numbers/route");
const suggestions = await import("./suggestions/route");

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

async function seed(ctx: TenantContext, id: string, grants: ConnectionGrant[], over: Partial<Pick<DataConnection, "status" | "collect">> = {}) {
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
      status: over.status ?? "connected",
      createdAt: T0,
      updatedAt: T0,
      disconnectedAt: over.status === "disconnected" ? T0 : null,
      ...(over.collect ? { collect: over.collect } : {}),
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

describe("/api/agent/connectors/numbers", () => {
  // Collected numbers: 10 made-up UTC days to 21 Nov, read from the brand's own snapshots only.
  const NOW = new Date("2026-11-23T10:00:00.000Z");
  const COLLECTED = "dcn_dddddddddddddddddddd";
  const GONE = "dcn_eeeeeeeeeeeeeeeeeeee";
  const collect = CollectStateSchema.parse({ gen: 0, lastDay: "2026-11-21", finalThrough: "2026-11-21", backfilledTo: "2026-11-12", timeZone: "UTC" });
  const ask = (body: unknown) =>
    numbers.POST(new Request("http://localhost/api/agent/connectors/numbers", { method: "POST", headers: { "x-canvas-context": "tok", "content-type": "application/json" }, body: JSON.stringify(body) }));
  const month = (over: Record<string, unknown> = {}) => ask({ connectionId: COLLECTED, stream: "zone_daily", period: "last_28_days", ...over });

  async function collected(ctx: TenantContext, id: string) {
    const owner = { id, connectorId: "cloudflare", account: ZONE, gen: 0 };
    for (let i = 0; i < 10; i++) {
      const day = addDays("2026-11-21", -i);
      await writeDayDoc(ctx, { owner, stream: "zone_daily", by: "day", day, timeZone: "UTC", final: true, more: false, keepDays: 90, totals: { cfRequests: 1000, cfPageViews: 100, cfVisits: 40, cfUniqueVisitors: 30 }, rows: [], basis: "end_users" }, { db, now: NOW });
    }
    await rollConnection(ctx, { owner, stream: "zone_daily", by: ["day"], keepDays: 90, lastDay: "2026-11-21", backfilledTo: "2026-11-12", timeZone: "UTC" }, { db, now: NOW });
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    vi.stubEnv("CONNECTORS_COLLECT_ENABLED", "true");
    await seed(A, COLLECTED, [{ to: "agent:vizzy", can: "read" }], { collect });
    await collected(A, COLLECTED);
    await seed(A, GONE, [{ to: "agent:vizzy", can: "read" }], { collect, status: "disconnected" });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is unavailable while Vizzy's connected data or collected numbers is off, before reading the token", async () => {
    vi.stubEnv("CONNECTORS_COLLECT_ENABLED", "false");
    expect((await month()).status).toBe(503);
    expect(await (await month()).json()).toEqual({ error: "unavailable" });
    vi.stubEnv("CONNECTORS_COLLECT_ENABLED", "true");
    vi.stubEnv("CONNECTORS_CHAT_ENABLED", "false");
    expect((await month()).status).toBe(503);
    vi.stubEnv("CONNECTORS_CHAT_ENABLED", "true");
    vi.stubEnv("CONNECTORS_ENABLED", "false");
    expect((await month()).status).toBe(503);
    expect(auth.verifyCanvasContext).not.toHaveBeenCalled();
    // Live reads go on with collected numbers off.
    vi.stubEnv("CONNECTORS_ENABLED", "true");
    vi.stubEnv("CONNECTORS_COLLECT_ENABLED", "false");
    expect((await get()).status).toBe(200);
  });

  it("reads collected numbers with the grant, from the token's brand, every number with its meaning, and never the provider", async () => {
    const res = await month();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.connection).toEqual({ id: COLLECTED, connectorId: "cloudflare", connector: "Cloudflare", label: `Cloudflare ${COLLECTED.slice(-4)}` });
    expect(body.period).toEqual({ from: "2026-11-12", to: "2026-11-21", timeZone: "UTC", finalThrough: "2026-11-21", words: "12 Nov to 21 Nov 2026, UTC" });
    expect(body.lag).toBe("Each day is collected 2 days later.");
    expect(body.totals).toEqual({ cfRequests: 10000, cfPageViews: 1000, cfVisits: 400, cfUniqueVisitors: null });
    expect(body.rows).toHaveLength(10);
    // The contract: every number anywhere in the answer has its meaning, word for word.
    for (const k of numberKeys(body)) expect(body.meanings[k], k).toEqual(shownMeaning(MEANINGS[k as keyof typeof MEANINGS]));
    expect(Object.keys(body.meanings)).toEqual(expect.arrayContaining(["rowsDropped", "lagDays", "cfRequests", "cfUniqueVisitors"]));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses without the grant, another brand's connection and a disconnected one", async () => {
    const no = await ask({ connectionId: PRIVATE, stream: "zone_daily", period: "last_7_days" });
    expect(no.status).toBe(403);
    expect(await no.json()).toMatchObject({ error: "no_agent_grant" });
    auth.verifyCanvasContext.mockReturnValue(claims("member"));
    const member = await month();
    expect(member.status).toBe(403);
    expect(await member.json()).toMatchObject({ error: "no_read_grant" });
    auth.verifyCanvasContext.mockReturnValue(claims("admin"));
    expect((await ask({ connectionId: THEIRS, stream: "zone_daily", period: "last_7_days" })).status).toBe(404);
    const gone = await ask({ connectionId: GONE, stream: "zone_daily", period: "last_7_days" });
    expect(gone.status).toBe(409);
    expect(await gone.json()).toMatchObject({ error: "disconnected" });
  });

  it("400s bad input, including a brand in the body and a page by day", async () => {
    expect((await month({ tenantId: "ten_B" })).status).toBe(400);
    expect((await month({ limit: 101 })).status).toBe(400);
    expect((await month({ from: "2026-11-01", to: "2026-11-02" })).status).toBe(400);
    expect((await numbers.POST(new Request("http://localhost/api/agent/connectors/numbers", { method: "POST", headers: { "x-canvas-context": "tok" }, body: "not json" }))).status).toBe(400);
    expect(await (await ask({ connectionId: COLLECTED, stream: "zone_daily", period: "last_7_days", by: "page" })).json()).toEqual({ error: "by_not_allowed" });
  });

  it("counts in its own rate limit, apart from live reads", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await month()).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect(await (await month()).json()).toEqual({ error: "rate_limited" });
    // The live bucket is untouched.
    expect((await get()).status).toBe(200);
    expect(CONNECTORS_NUMBERS_LIMIT).toEqual({ prefix: "connectors_numbers", burstLimit: 10, hourlyLimit: 120 });
    expect(CONNECTORS_AGENT_LIMIT.prefix).not.toBe(CONNECTORS_NUMBERS_LIMIT.prefix);
  });
});

describe("/api/agent/connectors/suggestions", () => {
  // Open suggestions from collected numbers: made-up sites, pages and searches, read only.
  const SC = "dcn_ffffffffffffffffffff";
  const MEMBERS_ONLY = "dcn_gggggggggggggggggggg";
  const ask = (body?: unknown) =>
    suggestions.POST(new Request("http://localhost/api/agent/connectors/suggestions", { method: "POST", headers: { "x-canvas-context": "tok", "content-type": "application/json" }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) }));

  beforeEach(async () => {
    vi.stubEnv("CONNECTORS_COLLECT_ENABLED", "true");
    vi.stubEnv("CONNECTOR_SIGNALS_ENABLED", "true");
    const { seedSearchConsole, seedSuggestion } = await import("@/lib/connectors/testing/signals");
    await seedSearchConsole(A, db, SC);
    await seedSearchConsole(A, db, MEMBERS_ONLY, { account: "sc-domain:shop.fernhill.example", grants: [{ to: "members", can: "read" }] });
    await seedSuggestion(A, db, SC, "losing");
    await seedSuggestion(A, db, SC, "reach");
    await seedSuggestion(A, db, MEMBERS_ONLY, "rising", { account: "sc-domain:shop.fernhill.example" });
    await seedSuggestion(B, db, SC, "rising");
  });

  it("is unavailable while signals are off, whatever Vizzy's other switches say", async () => {
    vi.stubEnv("CONNECTOR_SIGNALS_ENABLED", "false");
    expect((await ask()).status).toBe(503);
    vi.stubEnv("CONNECTOR_SIGNALS_ENABLED", "true");
    vi.stubEnv("CONNECTORS_COLLECT_ENABLED", "false");
    expect((await ask()).status).toBe(503);
    expect(auth.verifyCanvasContext).not.toHaveBeenCalled();
    // Chat off doesn't stop it: it needs signals, not live reads.
    vi.stubEnv("CONNECTORS_COLLECT_ENABLED", "true");
    vi.stubEnv("CONNECTORS_CHAT_ENABLED", "false");
    expect((await ask()).status).toBe(200);
  });

  it("lists the token's brand's open suggestions from planning connections, every number with its meaning", async () => {
    const res = await ask();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.suggestions.map((s: { rule: string }) => s.rule).sort()).toEqual(["losing_page", "within_reach"]);
    const losing = body.suggestions.find((s: { rule: string }) => s.rule === "losing_page");
    expect(losing).toMatchObject({
      title: "Fewer Google clicks to /care/fiddle-leaf-fig",
      lines: ["41 clicks in the 28 days to 20 Nov, down from 96 in the 28 days before."],
      label: "/care/fiddle-leaf-fig",
      numbers: { searchClicks: 41 },
      before: { searchClicks: 96 },
      where: "review",
      agentActionId: expect.stringMatching(/^aa_/),
      connection: { id: SC, connector: "Google Search Console", site: "fernhill.example" },
    });
    for (const k of numberKeys(body)) expect(body.meanings[k], k).toEqual(shownMeaning(MEANINGS[k as keyof typeof MEANINGS]));
    expect(body.note).toContain("Read only");
    expect((await (await ask({ rule: "within_reach", limit: 5 })).json()).suggestions).toHaveLength(1);
    // A member reads the same: a planning connection lets members read it.
    auth.verifyCanvasContext.mockReturnValue(claims("member"));
    expect((await (await ask()).json()).suggestions).toHaveLength(2);
  });

  it("400s a brand in the body, a bad rule or limit, and a body that isn't JSON", async () => {
    expect((await ask({ tenantId: "ten_B" })).status).toBe(400);
    expect((await ask({ rule: "everything" })).status).toBe(400);
    expect((await ask({ limit: 51 })).status).toBe(400);
    expect((await ask("not json")).status).toBe(400);
  });

  it("counts in the collected numbers' own rate limit", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await ask()).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

