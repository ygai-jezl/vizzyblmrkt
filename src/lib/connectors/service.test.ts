import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { shapeRecordingFirestore } from "@/lib/tenant/testing/queryShape";
import type { TenantContext } from "@/lib/tenant";
import type { ConnectorActor } from "./grants";
import { check, connect, disconnect, getForActor, listForActor, readLiveFor, setGrants, setPaused } from "./service";

// Cloudflare is never called: every provider call goes through a stub transport.
const A: TenantContext = { tenantId: "ten_a", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const admin: ConnectorActor = { kind: "human", uid: "usr_admin", role: "admin" };
const member: ConnectorActor = { kind: "human", uid: "usr_member", role: "member" };
const ZONE = "0123456789abcdef0123456789abcdef";
const TOKEN = "made-up-cloudflare-token-0000000000";
const ID = "dcn_aaaaaaaaaaaaaaaaaaaa";
const NOW = new Date("2026-11-21T10:00:00.000Z");

const answer = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const PROBE_OK = { data: { viewer: { zones: [{ httpRequests1dGroups: [] }] } }, errors: null };
const DAILY_OK = {
  data: { viewer: { zones: [{ totals: [{ dimensions: { date: "2026-11-20" }, sum: { requests: 2400, pageViews: 310 } }], visits: [{ dimensions: { date: "2026-11-20" }, sum: { visits: 140 } }] }] } },
  errors: null,
};

let db: FakeFirestore;
let transport: ReturnType<typeof vi.fn>;
const deps = (over: { now?: Date } = {}) => ({ db, transport, limit: async () => false, log: () => {}, newId: () => ID, now: over.now ?? NOW });

beforeEach(() => {
  db = new FakeFirestore();
  transport = vi.fn(async () => answer(PROBE_OK));
  vi.stubEnv("CONNECTORS_ENABLED", "true");
  vi.stubEnv("CONNECTOR_CLOUDFLARE_ENABLED", "true");
  vi.stubEnv("CONNECTORS_VAULT_KEY", "service-test-vault-root-0123456789abcdef");
});
afterEach(() => vi.unstubAllEnvs());

const connectOk = () => connect(A, admin, "cloudflare", { fields: { zoneId: ZONE, token: TOKEN }, label: "Main site" }, deps());
const raw = () => db.raw("data_connections", ID)!;
const activity = () => db.dump("data_connection_activity").map((a) => `${a.kind}${a.code ? `:${a.code}` : ""}`);

describe("connect", () => {
  it("checks the token first, then saves the record with the token sealed and a connected row", async () => {
    const r = await connectOk();
    expect(r).toMatchObject({ ok: true, status: 201, value: { id: ID, label: "Main site", health: { state: "ok" }, details: { account: ZONE, ownerUid: "usr_admin", grants: [] } } });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(raw())).not.toContain(TOKEN);
    expect(raw().secrets).toMatchObject({ token: { encKeyId: expect.stringMatching(/^[0-9a-f]{16}$/) } });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(activity()).toEqual(["connected"]);
  });

  it("saves nothing when the check fails, and says why in plain words", async () => {
    transport.mockResolvedValueOnce(answer({ data: null, errors: [{ message: "Unauthorized" }] }));
    const r = await connectOk();
    expect(r).toMatchObject({ ok: false, status: 502, error: "token_refused", message: expect.stringContaining("turned the token down") });
    expect(db.dump("data_connections")).toEqual([]);
  });

  it("refuses bad fields by name only, a member, an unknown connector and a second copy of an account", async () => {
    const bad = await connect(A, admin, "cloudflare", { fields: { zoneId: "nope", token: TOKEN, extra: "x" } }, deps());
    expect(bad).toEqual({ ok: false, status: 400, error: "invalid_fields", message: "Check extra, zoneId." });
    expect(JSON.stringify(bad)).not.toContain(TOKEN);
    expect(await connect(A, member, "cloudflare", { fields: { zoneId: ZONE, token: TOKEN } }, deps())).toMatchObject({ status: 403 });
    expect(await connect(A, admin, "github", { fields: {} }, deps())).toMatchObject({ status: 404 });
    expect(await connect(A, admin, "cloudflare", "not an object", deps())).toMatchObject({ status: 400, error: "invalid_input" });
    await connectOk();
    expect(await connect(A, admin, "cloudflare", { fields: { zoneId: ZONE, token: TOKEN } }, { ...deps(), newId: () => "dcn_bbbbbbbbbbbbbbbbbbbb" })).toMatchObject({ status: 409, error: "already_connected" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("refuses to connect with no vault key, before any call", async () => {
    vi.stubEnv("CONNECTORS_VAULT_KEY", "");
    expect(await connectOk()).toMatchObject({ ok: false, status: 503, error: "vault_unconfigured" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("hides the connector with its switch off", async () => {
    vi.stubEnv("CONNECTOR_CLOUDFLARE_ENABLED", "false");
    expect(await connectOk()).toMatchObject({ status: 404 });
  });
});

describe("check, pause and health", () => {
  beforeEach(async () => {
    await connectOk();
  });

  it("records a check that works, and one that finds the token refused", async () => {
    const later = new Date("2026-11-21T11:00:00.000Z");
    expect(await check(A, admin, ID, deps({ now: later }))).toMatchObject({ ok: true, value: { check: { ok: true }, connection: { health: { state: "ok", lastOkAt: later.toISOString() } } } });
    transport.mockResolvedValueOnce(answer({ errors: [{ message: "Unauthorized" }] }, 401));
    const r = await check(A, admin, ID, deps({ now: later }));
    expect(r).toMatchObject({ ok: true, value: { check: { ok: false, code: "token_refused" }, connection: { health: { state: "broken" } } } });
    expect(activity()).toEqual(["connected", "verified", "failed:token_refused"]);
  });

  it("pauses after the provider's rate limit and refuses calls until then, unless an admin resumes", async () => {
    transport.mockResolvedValueOnce(answer({}, 429, { "retry-after": "600" }));
    await check(A, admin, ID, deps());
    expect(raw().health).toMatchObject({ state: "paused", pausedUntil: "2026-11-21T10:10:00.000Z" });
    expect(activity()).toEqual(["connected", "failed:rate_limited", "paused:rate_limited"]);
    expect(await check(A, admin, ID, deps())).toMatchObject({ ok: false, status: 409, error: "paused" });
    expect(transport).toHaveBeenCalledTimes(2);
    await setPaused(A, admin, ID, false, deps());
    expect(raw().health).toMatchObject({ pausedUntil: null, state: "check" });
    expect((await check(A, admin, ID, deps())).ok).toBe(true);
  });

  it("lets an admin pause and resume, records each once, and refuses a member", async () => {
    expect(await setPaused(A, member, ID, true, deps())).toMatchObject({ status: 403 });
    expect(await setPaused(A, admin, ID, true, deps())).toMatchObject({ ok: true, value: { health: { state: "paused" }, details: { pausedBy: "usr_admin" } } });
    await setPaused(A, admin, ID, true, deps());
    expect(await check(A, admin, ID, deps())).toMatchObject({ status: 409, error: "paused" });
    await setPaused(A, admin, ID, false, deps());
    expect(activity()).toEqual(["connected", "paused", "resumed"]);
  });

  it("marks the connection broken when its token won't open any more", async () => {
    vi.stubEnv("CONNECTORS_VAULT_KEY", "a-different-vault-root-after-a-mistake-000");
    expect(await check(A, admin, ID, deps())).toMatchObject({ ok: false, status: 409, error: "secret_unopenable" });
    expect(raw().health).toMatchObject({ state: "broken", lastErrorCode: "secret_unopenable" });
  });
});

describe("live reads, grants and disconnect", () => {
  beforeEach(async () => {
    await connectOk();
    transport.mockImplementation(async () => answer(DAILY_OK));
  });
  const q = { stream: "zone_daily", from: "2026-11-20", to: "2026-11-20" };

  it("reads live for an admin with every number's meaning", async () => {
    const r = await readLiveFor(A, admin, ID, q, deps());
    expect(r).toMatchObject({ ok: true, value: { rows: [{ day: "2026-11-20", cfRequests: 2400, cfPageViews: 310, cfVisits: 140 }], meanings: { cfRequests: { name: "Cloudflare requests" } } } });
  });

  it("lets a member read only once the members grant is set, and shows them name and health only", async () => {
    expect(await readLiveFor(A, member, ID, q, deps())).toMatchObject({ ok: false, status: 403, error: "no_read_grant" });
    const seen = await getForActor(A, member, ID, deps());
    expect(seen.ok && seen.value.details).toBeUndefined();
    expect(seen.ok && seen.value.canReadLive).toBe(false);
    expect(await setGrants(A, member, ID, { grants: [{ to: "members", can: "read" }] }, deps())).toMatchObject({ status: 403 });
    await setGrants(A, admin, ID, { grants: [{ to: "members", can: "read" }, { to: "members", can: "read" }] }, deps());
    expect(raw().grants).toEqual([{ to: "members", can: "read" }]);
    expect((await readLiveFor(A, member, ID, q, deps())).ok).toBe(true);
    expect(activity()).toEqual(["connected", "grants_changed:members"]);
    expect(await setGrants(A, admin, ID, { grants: [{ to: "everyone", can: "read" }] }, deps())).toMatchObject({ status: 400 });
  });

  it("refuses a bad query and an over-long range before any call", async () => {
    transport.mockClear();
    expect(await readLiveFor(A, admin, ID, { ...q, from: "2026-01-01" }, deps())).toMatchObject({ status: 400, error: "too_many_days" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("disconnects: the secrets go, the record stays, and the answer says to delete the token at Cloudflare", async () => {
    expect(await disconnect(A, member, ID, deps())).toMatchObject({ status: 403 });
    const r = await disconnect(A, admin, ID, deps());
    expect(r).toMatchObject({ ok: true, value: { revoked: false, message: expect.stringContaining("delete it in Cloudflare"), connection: { status: "disconnected" } } });
    expect(raw()).toMatchObject({ secrets: {}, status: "disconnected", disconnectedAt: NOW.toISOString() });
    expect(await readLiveFor(A, admin, ID, q, deps())).toMatchObject({ status: 409, error: "disconnected" });
    const list = await listForActor(A, admin, deps());
    expect(list.ok && list.value.connections.map((c) => c.status)).toEqual(["disconnected"]);
    expect(activity()).toEqual(["connected", "disconnected"]);
  });

  it("keeps the connection but refuses reads while its connector is switched off", async () => {
    vi.stubEnv("CONNECTOR_CLOUDFLARE_ENABLED", "false");
    expect(await readLiveFor(A, admin, ID, q, deps())).toMatchObject({ status: 404, error: "connector_off" });
    const list = await listForActor(A, admin, deps());
    expect(list.ok && list.value.connectors).toEqual([]);
    expect(list.ok && list.value.connections[0]).toMatchObject({ id: ID, connectorOn: false });
  });
});

describe("query shape", () => {
  it("reads only by id or equality, with no sort or range, so no composite index is needed", async () => {
    const ops: string[] = [];
    db = shapeRecordingFirestore(new FakeFirestore(), ops);
    await connectOk();
    transport.mockImplementation(async () => answer(DAILY_OK));
    await listForActor(A, admin, deps());
    await check(A, admin, ID, deps());
    await readLiveFor(A, admin, ID, { stream: "zone_daily", from: "2026-11-20", to: "2026-11-20" }, deps());
    await setGrants(A, admin, ID, { grants: [{ to: "members", can: "read" }] }, deps());
    await setPaused(A, admin, ID, true, deps());
    await disconnect(A, admin, ID, deps());
    expect(ops.length).toBeGreaterThan(0);
    for (const op of ops) expect(op, op).toMatch(/^where \w+ ==$/);
  });
});
