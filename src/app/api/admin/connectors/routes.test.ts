import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { __resetRateLimitState } from "@/lib/tenant/rateLimit";

// The connector routes: switch off answers 404 before the session is read; signed out 401; a
// cross-site write 403; members are refused every manage route and read live only with the
// members grant; another brand's connection is 404; a bad body 400. Cloudflare is never called:
// the global fetch that src/lib/security/ssrf.ts uses is a stub.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const store = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => store.db,
}));

const list = await import("./route");
const connectRoute = await import("./[connectorId]/connect/route");
const tokenCheckRoute = await import("./[connectorId]/check/route");
const one = await import("./connections/[connectionId]/route");
const checkRoute = await import("./connections/[connectionId]/check/route");
const pauseRoute = await import("./connections/[connectionId]/pause/route");
const grantsRoute = await import("./connections/[connectionId]/grants/route");
const liveRoute = await import("./connections/[connectionId]/live/route");

const ORIGIN = "https://app.yougrow.test";
const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const member = { ...admin, userId: "usr_member", role: "member" };
const otherBrand = { ...admin, tenantId: "ten_B", userId: "usr_other" };
const ZONE = "0123456789abcdef0123456789abcdef";
const TOKEN = "made-up-cloudflare-token-0000000000";

const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const PROBE_OK = { data: { viewer: { zones: [{ httpRequests1dGroups: [] }] } }, errors: null };
const DAILY_OK = {
  data: {
    viewer: {
      zones: [
        {
          daily: [{ dimensions: { date: "2026-11-20" }, sum: { requests: 2600, pageViews: 330 }, uniq: { uniques: 95 } }],
          traffic: [{ dimensions: { date: "2026-11-20" }, count: 2400, sum: { visits: 140 } }],
          pages: [{ dimensions: { date: "2026-11-20" }, count: 310 }],
        },
      ],
    },
  },
  errors: null,
};

function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/api/admin/connectors${path}`, {
    method,
    headers: { "content-type": "application/json", host: "app.yougrow.test", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}
const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });

let db: FakeFirestore;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimitState();
  db = new FakeFirestore();
  store.db = db;
  fetchMock = vi.fn(async () => answer(PROBE_OK));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("CONNECTORS_ENABLED", "true");
  vi.stubEnv("CONNECTOR_CLOUDFLARE_ENABLED", "true");
  vi.stubEnv("CONNECTORS_VAULT_KEY", "route-test-vault-root-0123456789abcdef01");
  session.getAdminContext.mockResolvedValue(admin);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function connected(): Promise<string> {
  const res = await connectRoute.POST(req("POST", "/cloudflare/connect", { fields: { zoneId: ZONE, token: TOKEN } }), p({ connectorId: "cloudflare" }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** Every route, called for one connection id. */
const calls = (id: string) => ({
  list: () => list.GET(req("GET", "")),
  connect: () => connectRoute.POST(req("POST", "/cloudflare/connect", { fields: { zoneId: ZONE, token: TOKEN } }), p({ connectorId: "cloudflare" })),
  checkToken: () => tokenCheckRoute.POST(req("POST", "/cloudflare/check", { fields: { token: TOKEN } }), p({ connectorId: "cloudflare" })),
  read: () => one.GET(req("GET", `/connections/${id}`), p({ connectionId: id })),
  disconnect: () => one.DELETE(req("DELETE", `/connections/${id}`), p({ connectionId: id })),
  check: () => checkRoute.POST(req("POST", `/connections/${id}/check`), p({ connectionId: id })),
  pause: () => pauseRoute.POST(req("POST", `/connections/${id}/pause`, { paused: true }), p({ connectionId: id })),
  grants: () => grantsRoute.PUT(req("PUT", `/connections/${id}/grants`, { grants: [{ to: "members", can: "read" }] }), p({ connectionId: id })),
  live: () => liveRoute.GET(req("GET", `/connections/${id}/live?stream=zone_daily&from=2026-11-20&to=2026-11-20`), p({ connectionId: id })),
});
const MANAGE = ["connect", "checkToken", "disconnect", "check", "pause", "grants"] as const;

describe("the connector routes", () => {
  it("answer 404 on every route with CONNECTORS_ENABLED off, before reading the session", async () => {
    vi.stubEnv("CONNECTORS_ENABLED", "false");
    for (const [name, call] of Object.entries(calls("dcn_aaaaaaaaaaaaaaaaaaaa"))) {
      const res = await call();
      expect(res.status, name).toBe(404);
    }
    expect(session.getAdminContext).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answer 401 signed out", async () => {
    session.getAdminContext.mockResolvedValue(null);
    for (const [name, call] of Object.entries(calls("dcn_aaaaaaaaaaaaaaaaaaaa"))) expect((await call()).status, name).toBe(401);
  });

  it("refuse a cross-site request, read or write", async () => {
    const id = await connected();
    const cross = { "sec-fetch-site": "cross-site" };
    expect((await one.DELETE(req("DELETE", `/connections/${id}`, undefined, cross), p({ connectionId: id }))).status).toBe(403);
    expect((await connectRoute.POST(req("POST", "/cloudflare/connect", { fields: {} }, { origin: "https://evil.example" }), p({ connectorId: "cloudflare" }))).status).toBe(403);
    expect((await list.GET(req("GET", "", undefined, cross))).status).toBe(403);
    expect(db.raw("data_connections", id)?.status).toBe("connected");
  });

  it("connect, list and read for an admin, never sending a secret back", async () => {
    const id = await connected();
    const all = await (await list.GET(req("GET", ""))).json();
    expect(all.connectors.map((c: { id: string }) => c.id)).toEqual(["cloudflare"]);
    expect(all.connections).toHaveLength(1);
    const res = await one.GET(req("GET", `/connections/${id}`), p({ connectionId: id }));
    const body = await res.json();
    expect(body.details).toMatchObject({ account: ZONE, secrets: [{ slot: "token" }] });
    expect(JSON.stringify(all) + JSON.stringify(body)).not.toContain(TOKEN);
    expect(JSON.stringify(body)).not.toContain('"ct"');
  });

  it("refuse a member every manage route with 403, and change nothing", async () => {
    const id = await connected();
    session.getAdminContext.mockResolvedValue(member);
    const c = calls(id);
    for (const name of MANAGE) expect((await c[name]()).status, name).toBe(403);
    expect(db.raw("data_connections", id)).toMatchObject({ status: "connected", grants: [], pausedAt: null });
    const seen = await (await c.read()).json();
    expect(seen.details).toBeUndefined();
    expect(seen.health.state).toBe("ok");
  });

  it("let a member read live only with the members grant", async () => {
    const id = await connected();
    session.getAdminContext.mockResolvedValue(member);
    expect((await calls(id).live()).status).toBe(403);
    session.getAdminContext.mockResolvedValue(admin);
    expect((await calls(id).grants()).status).toBe(200);
    session.getAdminContext.mockResolvedValue(member);
    // Two calls (the zone's settings, then its numbers), each answered afresh.
    fetchMock.mockImplementation(async () => answer(DAILY_OK));
    const res = await calls(id).live();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows).toEqual([{ day: "2026-11-20", cfRequests: 2400, cfPageViews: 310, cfVisits: 140, cfUniqueVisitors: 95 }]);
    expect(Object.keys(body.meanings).sort()).toEqual(["cfPageViews", "cfRequests", "cfUniqueVisitors", "cfVisits"]);
    expect(body.period).toMatchObject({ from: "2026-11-20", to: "2026-11-20", timeZone: "UTC", words: "20 Nov 2026, UTC" });
  });

  it("treat another brand's connection as not there", async () => {
    const id = await connected();
    session.getAdminContext.mockResolvedValue(otherBrand);
    const c = calls(id);
    for (const name of ["read", "disconnect", "check", "pause", "grants", "live"] as const) expect((await c[name]()).status, name).toBe(404);
    expect(db.raw("data_connections", id)).toMatchObject({ tenantId: "ten_A", status: "connected", grants: [] });
    const all = await (await c.list()).json();
    expect(all.connections).toEqual([]);
  });

  it("answer 400 for a bad body or query", async () => {
    const id = await connected();
    expect((await connectRoute.POST(req("POST", "/cloudflare/connect", "{not json"), p({ connectorId: "cloudflare" }))).status).toBe(400);
    expect((await connectRoute.POST(req("POST", "/cloudflare/connect", { fields: { zoneId: "short", token: TOKEN } }), p({ connectorId: "cloudflare" }))).status).toBe(400);
    expect((await pauseRoute.POST(req("POST", `/connections/${id}/pause`, { paused: "yes" }), p({ connectionId: id }))).status).toBe(400);
    expect((await grantsRoute.PUT(req("PUT", `/connections/${id}/grants`, { grants: [{ to: "members", can: "write" }] }), p({ connectionId: id }))).status).toBe(400);
    expect((await liveRoute.GET(req("GET", `/connections/${id}/live?stream=zone_daily&from=2026-11-20`), p({ connectionId: id }))).status).toBe(400);
  });

  it("check a pasted token for an admin, listing its zones and saving nothing", async () => {
    fetchMock.mockResolvedValue(answer({ success: true, errors: [], result: [{ id: ZONE, name: "acme.example", status: "active" }], result_info: { total_pages: 1 } }));
    const res = await calls("unused").checkToken();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ accounts: [{ id: ZONE, label: "acme.example", detail: null }], more: false, listed: true });
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/^https:\/\/api\.cloudflare\.com\/client\/v4\/zones\?/);
    expect(db.dump("data_connections")).toEqual([]);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    fetchMock.mockResolvedValue(answer({ success: false, errors: [{ code: 1000, message: "Invalid API Token" }] }, 400));
    const refused = await calls("unused").checkToken();
    expect(refused.status).toBe(502);
    expect(await refused.json()).toMatchObject({ error: "token_refused" });
    const logged = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().map(String).join("\n");
    expect(logged).not.toContain(TOKEN);
    expect((await tokenCheckRoute.POST(req("POST", "/cloudflare/check", "{not json"), p({ connectorId: "cloudflare" }))).status).toBe(400);
  });

  it("check, pause and disconnect for an admin", async () => {
    const id = await connected();
    const c = calls(id);
    const checked = await (await c.check()).json();
    expect(checked.check).toEqual({ ok: true, code: null, message: null });
    expect((await (await c.pause()).json()).health.state).toBe("paused");
    const gone = await (await c.disconnect()).json();
    expect(gone).toMatchObject({ revoked: false, connection: { status: "disconnected" } });
    expect(db.raw("data_connections", id)?.secrets).toEqual({});
  });
});
