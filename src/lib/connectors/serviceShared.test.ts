import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { shapeRecordingFirestore } from "@/lib/tenant/testing/queryShape";
import { createDataConnection, forTenant, type TenantContext } from "@/lib/tenant";
import type { ConnectorActor } from "./grants";
import { getConnector, readyMethods, knownConnector } from "./registry";
import { agentConnections, agentLiveRead } from "./agentApi";
import { purgeConnections } from "./purge";
import { ADDRESS_DELETED_MESSAGE, ADDRESS_KEPT_MESSAGE, check, checkAccess, disconnect, listForActor, pickAccount, readLiveFor, setGrants, SHARE_ADDRESS_CAP, shareConnect } from "./service";
import { CONNECTOR_ERRORS } from "./messages";
import { __resetShareTokens, brandTag } from "./shareAccess";

// The search databases: an in-memory index, since every erase removes a Search Console
// connection's searches from brand search whatever SEARCH_INDEX_ENABLED says (ADR-0013).
vi.mock("@/lib/tenant/searchIndex", async () => {
  const { MemorySearchIndex } = await import("@/lib/search/memoryStore");
  const index = new MemorySearchIndex();
  return { searchStoreFor: (ctx: { tenantId: string }) => index.storeFor(ctx) };
});

// Search Console by share access, through the service: a Google address made per connection,
// Check access, the picker, a live read with a minted token, and Disconnect deleting the address.
// Google is never called: one stub transport plays IAM, IAM Credentials and Search Console.
const A: TenantContext = { tenantId: "ten_a", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const admin: ConnectorActor = { kind: "human", uid: "usr_admin", role: "admin" };
const member: ConnectorActor = { kind: "human", uid: "usr_member", role: "member" };
const PROJECT = "made-up-identities";
const NOW = new Date("2026-11-21T10:00:00.000Z");
const SITES = { siteEntry: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteRestrictedUser" }] };
const ROWS = { rows: [{ keys: ["2026-11-10"], clicks: 5, impressions: 100, ctr: 0.05, position: 6.5 }] };

const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let db: FakeFirestore;
let accounts: Map<string, { email: string; uniqueId: string; description: string }>;
let sitesAnswer: () => Response;
let deleteStatus: number;
let createAnswer: (() => Response) | null;
let ids: string[];
let transport: ReturnType<typeof vi.fn>;
const deps = () => ({ db, transport, limit: async () => false, log: () => {}, now: NOW, sleep: async () => {}, appToken: async () => "made-up-app-token", newId: () => ids.shift()! });
const urls = () => transport.mock.calls.map((c) => `${(c[1] as RequestInit).method} ${String(c[0])}`);
const activity = () => db.dump("data_connection_activity").map((a) => `${a.kind}${a.code ? `:${a.code}` : ""}`);
const load = async (id: string) => (await forTenant(A, db).dataConnections.getById(id))!;
/** Mark a shared connection as reading a site, so it no longer waits for one. */
const changeAccount = async (id: string, account: string) => {
  const { changeDataConnection } = await import("@/lib/tenant");
  await changeDataConnection(A, id, () => ({ patch: { account }, activity: [] }), db);
};

beforeEach(() => {
  __resetShareTokens();
  db = new FakeFirestore();
  accounts = new Map();
  ids = ["dcn_aaaaaaaaaaaaaaaaaaaa", "dcn_bbbbbbbbbbbbbbbbbbbb", "dcn_cccccccccccccccccccc"];
  sitesAnswer = () => answer(SITES);
  deleteStatus = 200;
  createAnswer = null;
  let n = 1000;
  transport = vi.fn(async (url: string, init: RequestInit) => {
    const u = new URL(url);
    if (u.hostname === "iam.googleapis.com" && init.method === "POST") {
      if (createAnswer) return createAnswer();
      const body = JSON.parse(String(init.body));
      const a = { email: `${body.accountId}@${PROJECT}.iam.gserviceaccount.com`, uniqueId: String(n++), description: body.serviceAccount.description };
      accounts.set(a.uniqueId, a);
      return answer(a);
    }
    if (u.hostname === "iam.googleapis.com" && init.method === "DELETE") {
      if (deleteStatus !== 200) return answer({ error: { status: "UNAVAILABLE" } }, deleteStatus);
      accounts.delete(u.pathname.split("/").pop()!);
      return answer({});
    }
    if (u.hostname === "iamcredentials.googleapis.com") return answer({ accessToken: "made-up-minted", expireTime: new Date(NOW.getTime() + 300_000).toISOString() });
    if (url === "https://searchconsole.googleapis.com/webmasters/v3/sites") return sitesAnswer();
    if (url.includes("/searchAnalytics/query")) return answer(ROWS);
    return answer({}, 500);
  });
  vi.stubEnv("CONNECTORS_ENABLED", "true");
  vi.stubEnv("CONNECTOR_SEARCH_CONSOLE_ENABLED", "true");
  vi.stubEnv("CONNECTORS_IDENTITIES_PROJECT", PROJECT);
});
afterEach(() => vi.unstubAllEnvs());

describe("share access in the catalogue", () => {
  it("is offered only with the identities project, and Search Console then needs no Google client", () => {
    expect(readyMethods(knownConnector("search-console")!)).toEqual(["share_access"]);
    expect(getConnector("search-console")?.id).toBe("search-console");
    vi.stubEnv("CONNECTORS_IDENTITIES_PROJECT", "");
    expect(readyMethods(knownConnector("search-console")!)).toEqual([]);
    expect(getConnector("search-console")).toBeNull();
    vi.stubEnv("CONNECTOR_GOOGLE_CLIENT_ID", "made-up-client.example.test");
    vi.stubEnv("CONNECTOR_GOOGLE_CLIENT_SECRET", "made-up-client-secret");
    expect(readyMethods(knownConnector("search-console")!)).toEqual(["oauth_pkce"]);
  });

  it("is refused without the identities project, and for members", async () => {
    vi.stubEnv("CONNECTOR_GOOGLE_CLIENT_ID", "made-up-client.example.test");
    vi.stubEnv("CONNECTOR_GOOGLE_CLIENT_SECRET", "made-up-client-secret");
    vi.stubEnv("CONNECTORS_IDENTITIES_PROJECT", "");
    expect(await shareConnect(A, admin, "search-console", {}, deps())).toMatchObject({ ok: false, status: 503, error: "share_unconfigured" });
    vi.stubEnv("CONNECTORS_IDENTITIES_PROJECT", PROJECT);
    expect(await shareConnect(A, member, "search-console", {}, deps())).toMatchObject({ ok: false, status: 403 });
    expect(await shareConnect(A, admin, "cloudflare", {}, deps())).toMatchObject({ ok: false, status: 404 });
    expect(transport).not.toHaveBeenCalled();
  });
});

describe("connecting by share access", () => {
  it("makes one address per connection, never named for the brand, and saves no secret", async () => {
    const r = await shareConnect(A, admin, "search-console", { label: "Our site" }, deps());
    expect(r).toMatchObject({ ok: true, status: 201 });
    if (!r.ok) return;
    expect(r.value.reused).toBe(false);
    expect(r.value.share.role).toBe("Restricted");
    expect(r.value.share.steps.at(-1)).toContain("Check access");
    expect(r.value.share.email).toMatch(/^ygc-[a-z2-7]{20}@made-up-identities\.iam\.gserviceaccount\.com$/);
    expect(r.value.share.email).not.toContain("ten_a");
    const conn = await load(r.value.connection.id);
    expect(conn).toMatchObject({ method: "share_access", account: "", secrets: {}, health: { state: "check" }, serviceAccount: { email: r.value.share.email, deletedAt: null } });
    expect([...accounts.values()][0]!.description).toContain(`brand=${brandTag("ten_a")}`);
    expect(activity()).toEqual(["shared"]);
    expect(r.value.connection.details?.serviceAccount).toEqual({ email: r.value.share.email, deletedAt: null });
  });

  it("gives back the connection still waiting for its property instead of making another address", async () => {
    const first = await shareConnect(A, admin, "search-console", {}, deps());
    const again = await shareConnect(A, admin, "search-console", {}, deps());
    expect(again).toMatchObject({ ok: true, status: 200, value: { reused: true } });
    if (!first.ok || !again.ok) return;
    expect(again.value.share.email).toBe(first.value.share.email);
    expect(accounts.size).toBe(1);
  });

  it("says plainly when the project is full, offering sign in", async () => {
    createAnswer = () => answer({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Maximum number of service accounts on project reached." } }, 429);
    const r = await shareConnect(A, admin, "search-console", {}, deps());
    expect(r).toMatchObject({ ok: false, status: 503, error: "share_quota" });
    expect(!r.ok && r.message).toContain("Sign in with Google instead");
    expect(db.dump("data_connections")).toEqual([]);
  });

  it("stops a brand holding the most addresses one brand may have for a connector, counting ones a failed delete left", async () => {
    ids.push("dcn_dddddddddddddddddddd", "dcn_eeeeeeeeeeeeeeeeeeee");
    // One shared connection made for real, then copied with picked sites to fill the allowance.
    const first = await shareConnect(A, admin, "search-console", {}, deps());
    if (!first.ok) throw new Error("not shared");
    await changeAccount(first.value.connection.id, "sc-domain:site0.example.com");
    const base = await load(first.value.connection.id);
    const { tenantId: _t, recent: _r, ...rest } = base;
    const copyId = (n: number) => `dcn_${"ghjkmnpqrs"[n]!.repeat(20)}`;
    const copy = (n: number, patch: Partial<typeof base> = {}) =>
      createDataConnection(
        A,
        { ...rest, id: copyId(n), account: `sc-domain:site${n}.example.com`, serviceAccount: { ...base.serviceAccount!, uniqueId: String(5000 + n) }, ...patch },
        [],
        db,
      );
    for (let n = 1; n < SHARE_ADDRESS_CAP - 1; n++) await copy(n);
    // A disconnected connection whose address is gone at Google doesn't count.
    await copy(8, { status: "disconnected", serviceAccount: { ...base.serviceAccount!, uniqueId: "5008", deletedAt: NOW.toISOString() } });
    const fifth = await shareConnect(A, admin, "search-console", {}, deps());
    expect(fifth).toMatchObject({ ok: true, status: 201 });
    if (!fifth.ok) return;
    await changeAccount(fifth.value.connection.id, `sc-domain:site${SHARE_ADDRESS_CAP - 1}.example.com`);

    transport.mockClear();
    const full = await shareConnect(A, admin, "search-console", {}, deps());
    expect(full).toMatchObject({ ok: false, status: 409, error: "share_limit", message: CONNECTOR_ERRORS.share_limit });
    expect(CONNECTOR_ERRORS.share_limit).toContain(`${SHARE_ADDRESS_CAP} shared Google addresses`);
    expect(transport).not.toHaveBeenCalled();

    // Disconnected with its address left at Google by a failed delete: it still counts.
    const { changeDataConnection } = await import("@/lib/tenant");
    await changeDataConnection(A, copyId(1), () => ({ patch: { status: "disconnected" }, activity: [] }), db);
    expect(await shareConnect(A, admin, "search-console", {}, deps())).toMatchObject({ status: 409, error: "share_limit" });
    // Once the purge deletes it, there is room again.
    await changeDataConnection(A, copyId(1), (cur) => ({ patch: { serviceAccount: { ...cur.serviceAccount!, deletedAt: NOW.toISOString() } }, activity: [] }), db);
    expect(await shareConnect(A, admin, "search-console", {}, deps())).toMatchObject({ ok: true, status: 201 });

    // Another connector, and another brand, are counted on their own.
    vi.stubEnv("CONNECTOR_GA4_ENABLED", "true");
    expect(await shareConnect(A, admin, "google-analytics", {}, deps())).toMatchObject({ ok: true, status: 201 });
    const B: TenantContext = { ...A, tenantId: "ten_b" };
    expect(await shareConnect(B, admin, "search-console", {}, deps())).toMatchObject({ ok: true, status: 201 });
  });

  it("refuses a bad body and a brand making addresses too fast", async () => {
    expect(await shareConnect(A, admin, "search-console", { tenantId: "ten_b" }, deps())).toMatchObject({ status: 400 });
    expect(await shareConnect(A, admin, "search-console", {}, { ...deps(), limit: async () => true })).toMatchObject({ status: 429, error: "busy" });
    expect(accounts.size).toBe(0);
  });
});

describe("Check access, picking and reading", () => {
  async function shared(): Promise<string> {
    const r = await shareConnect(A, admin, "search-console", {}, deps());
    if (!r.ok) throw new Error("not shared");
    return r.value.connection.id;
  }

  it("says the property isn't visible yet, in the help page's words, and marks it", async () => {
    const id = await shared();
    sitesAnswer = () => answer({});
    const r = await checkAccess(A, admin, id, deps());
    expect(r).toMatchObject({ ok: true, value: { visible: false, accounts: [] } });
    expect(r.ok && r.value.message).toMatch(/^We can't see your property yet\./);
    expect((await load(id)).health).toMatchObject({ state: "broken", lastErrorCode: "share_not_visible" });
    expect(activity()).toEqual(["shared", "access_checked:share_not_visible"]);
  });

  it("lists what the address sees with a minted token, then picks, reads and checks with it", async () => {
    const id = await shared();
    const r = await checkAccess(A, admin, id, deps());
    expect(r).toMatchObject({ ok: true, value: { visible: true, message: null, accounts: [{ id: "sc-domain:example.com", detail: "Restricted user" }] } });
    expect((await load(id)).health.state).toBe("ok");
    const minted = transport.mock.calls.find((c) => String(c[0]).includes("generateAccessToken"))!;
    expect(JSON.parse(String((minted[1] as RequestInit).body))).toEqual({ scope: ["https://www.googleapis.com/auth/webmasters.readonly"], lifetime: "300s" });
    const sitesCall = transport.mock.calls.find((c) => String(c[0]).endsWith("/webmasters/v3/sites"))!;
    expect(((sitesCall[1] as RequestInit).headers as Record<string, string>).authorization).toBe("Bearer made-up-minted");

    expect(await pickAccount(A, admin, id, { account: "sc-domain:example.com" }, deps())).toMatchObject({ ok: true, value: { needsAccount: false } });
    const live = await readLiveFor(A, admin, id, { stream: "search_performance", from: "2026-11-10", to: "2026-11-10" }, deps());
    expect(live).toMatchObject({ ok: true, value: { rows: [{ day: "2026-11-10", searchClicks: 5 }] } });
    expect(await check(A, admin, id, deps())).toMatchObject({ ok: true, value: { check: { ok: true } } });
    expect(activity()).toEqual(["shared", "access_checked:ok", "account_picked", "verified"]);
    // One token minted and kept in memory for every call; nothing sealed or stored.
    expect(urls().filter((u) => u.includes("generateAccessToken"))).toHaveLength(1);
    expect((await load(id)).secrets).toEqual({});
  });

  it("answers Vizzy's last 28 days with Search Console's own days and logs what was asked, never a number or a page", async () => {
    const id = await shared();
    await checkAccess(A, admin, id, deps());
    await pickAccount(A, admin, id, { account: "sc-domain:example.com" }, deps());
    await setGrants(A, admin, id, { grants: [{ to: "agent:vizzy", can: "read" }] }, deps());
    const asked: Array<Record<string, unknown>> = [];
    const plain = transport.getMockImplementation()!;
    transport.mockImplementation(async (url: string, init: RequestInit) => {
      if (!url.includes("/searchAnalytics/query")) return plain(url, init);
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      asked.push(body);
      // The date probe: 21 Nov (Pacific) is still being collected.
      if (body.rowLimit === 10) return answer({ rows: [{ keys: ["2026-11-20"], clicks: 1, impressions: 9 }], metadata: { first_incomplete_date: "2026-11-21" } });
      return answer({ rows: [{ keys: ["https://example.com/pricing"], clicks: 3, impressions: 50, ctr: 0.06, position: 4 }] });
    });
    const vizzy = { kind: "agent", agent: "vizzy", forRole: "admin" } as const;
    const r = await agentLiveRead(A, vizzy, { connectionId: id, stream: "search_performance", period: "last_28_days", by: "page", page: "/pricing" }, deps());
    expect(r.status).toBe(200);
    expect(asked[1]).toMatchObject({ startDate: "2026-10-24", endDate: "2026-11-20", dataState: "all", rowLimit: 1000 });
    expect(r.body).toMatchObject({
      connection: { id, connectorId: "search-console", connector: "Google Search Console" },
      by: "page",
      period: { from: "2026-10-24", to: "2026-11-20", timeZone: "America/Los_Angeles", finalThrough: "2026-11-18", words: "24 Oct to 20 Nov 2026, Pacific time" },
      rows: [{ page: "/pricing", host: "example.com", searchClicks: 3, searchImpressions: 50 }],
      more: false,
      notes: ["Search Console's numbers for 19 and 20 Nov may not be final yet. Its own report shows them too, and they may still change a little."],
    });
    expect(r.body).not.toHaveProperty("lag");
    // One page's rows are by host: no site totals, and no totals query.
    expect(r.body).not.toHaveProperty("totals");
    expect(asked).toHaveLength(2);
    const read = db.dump("data_connection_activity").find((a) => a.kind === "read")!;
    expect(read.read).toEqual({ stream: "search_performance", by: "page", from: "2026-10-24", to: "2026-11-20", timeZone: "America/Los_Angeles", limit: 100, period: "last_28_days", pageFilter: true });
    expect(JSON.stringify(read)).not.toContain("pricing");
  });

  it("gives Vizzy Google Analytics' own totals and days for a landing page read, in the property's zone", async () => {
    vi.stubEnv("CONNECTOR_GA4_ENABLED", "true");
    const made = await shareConnect(A, admin, "google-analytics", {}, deps());
    if (!made.ok) throw new Error("not shared");
    const id = made.value.connection.id;
    await changeAccount(id, "properties/1000");
    await setGrants(A, admin, id, { grants: [{ to: "agent:vizzy", can: "read" }] }, deps());
    const plain = transport.getMockImplementation()!;
    let sent: Record<string, unknown> = {};
    transport.mockImplementation(async (url: string, init: RequestInit) => {
      if (!url.startsWith("https://analyticsdata.googleapis.com/")) return plain(url, init);
      sent = JSON.parse(String(init.body)) as Record<string, unknown>;
      const header = [{ name: "sessions" }, { name: "activeUsers" }, { name: "keyEvents" }];
      const v = (...n: number[]) => n.map((x) => ({ value: String(x) }));
      return answer({
        metricHeaders: header,
        rows: [{ dimensionValues: [{ value: "/" }], metricValues: v(40, 30, 2) }],
        totals: [{ metricValues: v(55, 41, 3) }],
        rowCount: 7,
        metadata: { timeZone: "Europe/London" },
      });
    });
    const vizzy = { kind: "agent", agent: "vizzy", forRole: "admin" } as const;
    const r = await agentLiveRead(A, vizzy, { connectionId: id, stream: "site_traffic", period: "last_28_days", by: "landing", limit: 1 }, deps());
    expect(r.status).toBe(200);
    expect(sent).toMatchObject({ dateRanges: [{ startDate: "28daysAgo", endDate: "yesterday" }], dimensions: [{ name: "landingPage" }], metricAggregations: ["TOTAL"] });
    expect(r.body).toMatchObject({
      connection: { connectorId: "google-analytics", connector: "Google Analytics 4" },
      // 10:00 UTC on 21 Nov is 21 Nov in London, so Google's 28daysAgo to yesterday is 24 Oct to 20 Nov.
      period: { from: "2026-10-24", to: "2026-11-20", timeZone: "Europe/London", words: "24 Oct to 20 Nov 2026, United Kingdom time" },
      rows: [{ landing: "/", ga4Sessions: 40, ga4ActiveUsers: 30, ga4KeyEvents: 2 }],
      totals: { ga4Sessions: 55, ga4ActiveUsers: 41, ga4KeyEvents: 3 },
      more: true,
    });
    expect((r.body.notes as string[])[0]).toBe("Google Analytics lists 7 landing pages for these days; this shows the top 1 by sessions.");
    expect(Object.keys(r.body.meanings as object)).toEqual(["ga4Sessions", "ga4ActiveUsers", "ga4KeyEvents"]);
  });

  it("tells a property no longer shared from a provider error, in shared access words", async () => {
    const id = await shared();
    // Before it ever worked: it can't see the property yet.
    sitesAnswer = () => answer({ siteEntry: [] });
    expect(await checkAccess(A, admin, id, deps())).toMatchObject({ ok: true, value: { visible: false, message: CONNECTOR_ERRORS.share_not_visible } });
    sitesAnswer = () => answer(SITES);
    await checkAccess(A, admin, id, deps());
    await pickAccount(A, admin, id, { account: "sc-domain:example.com" }, deps());
    // After it worked: YouGrow lost access, dated from the first failure (pick 24).
    sitesAnswer = () => answer({ siteEntry: [] });
    expect(await checkAccess(A, admin, id, deps())).toMatchObject({ ok: true, value: { visible: false } });
    sitesAnswer = () => answer({ error: { status: "PERMISSION_DENIED" } }, 403);
    expect(await check(A, admin, id, deps())).toMatchObject({ ok: true, value: { check: { ok: false, code: "share_access_lost" } } });
    expect((await load(id)).health).toMatchObject({ state: "broken", lastErrorCode: "share_access_lost", since: NOW.toISOString() });
    const view = (await listForActor(A, admin, deps())).ok ? (await listForActor(A, admin, deps()) as { value: { connections: Array<{ health: { message: string | null } }> } }).value.connections[0]! : null;
    expect(view?.health.message).toBe("YouGrow lost access to this property on 21 Nov. Add the Google address again with the role shown, then press Check access.");
    sitesAnswer = () => answer({}, 503);
    expect(await checkAccess(A, admin, id, deps())).toMatchObject({ ok: false, status: 502, error: "provider_error" });
  });

  it("refuses Check access to members and to a connection that isn't shared", async () => {
    const id = await shared();
    expect(await checkAccess(A, member, id, deps())).toMatchObject({ status: 403 });
    expect(await checkAccess(A, admin, "dcn_zzzzzzzzzzzzzzzzzzzz", deps())).toMatchObject({ status: 404 });
  });

  it("hides the address from members, who see the name and health only", async () => {
    await shared();
    const r = await listForActor(A, member, deps());
    expect(r.ok && r.value.connections[0]!.details).toBeUndefined();
  });
});

describe("disconnecting a shared connection", () => {
  it("deletes its Google address and says what stays in the property", async () => {
    const made = await shareConnect(A, admin, "search-console", {}, deps());
    if (!made.ok) throw new Error("not shared");
    const r = await disconnect(A, admin, made.value.connection.id, deps());
    expect(r).toMatchObject({ ok: true, value: { addressDeleted: true, revoked: false, message: ADDRESS_DELETED_MESSAGE } });
    expect(accounts.size).toBe(0);
    const conn = await load(made.value.connection.id);
    expect(conn.status).toBe("disconnected");
    expect(conn.serviceAccount?.deletedAt).toBe(NOW.toISOString());
    expect(r.ok && r.value.connection.details?.serviceAccount?.deletedAt).toBe(NOW.toISOString());
    // A second disconnect touches nothing at Google.
    transport.mockClear();
    await disconnect(A, admin, made.value.connection.id, deps());
    expect(transport).not.toHaveBeenCalled();
  });

  it("records cleanup_failed when the delete fails, keeping the address for the purge", async () => {
    const made = await shareConnect(A, admin, "search-console", {}, deps());
    if (!made.ok) throw new Error("not shared");
    deleteStatus = 503;
    const r = await disconnect(A, admin, made.value.connection.id, deps());
    expect(r).toMatchObject({ ok: true, value: { addressDeleted: false, message: ADDRESS_KEPT_MESSAGE } });
    const conn = await load(made.value.connection.id);
    expect(conn.status).toBe("disconnected");
    expect(conn.serviceAccount?.deletedAt).toBeNull();
    expect(activity().sort()).toEqual(["cleanup_failed:provider_error", "disconnected", "erased:all", "shared"]);
    expect(accounts.size).toBe(1);
  });
});

describe("query shape", () => {
  it("reads only by id or equality, with no sort or range, so no composite index is needed", async () => {
    const ops: string[] = [];
    db = shapeRecordingFirestore(new FakeFirestore(), ops);
    const made = await shareConnect(A, admin, "search-console", {}, deps());
    if (!made.ok) throw new Error("not shared");
    const id = made.value.connection.id;
    await shareConnect(A, admin, "search-console", {}, deps());
    await checkAccess(A, admin, id, deps());
    await pickAccount(A, admin, id, { account: "sc-domain:example.com" }, deps());
    await setGrants(A, admin, id, { grants: [{ to: "agent:vizzy", can: "read" }] }, deps());
    const vizzy = { kind: "agent", agent: "vizzy", forRole: "admin" } as const;
    await agentConnections(A, vizzy, deps());
    await agentLiveRead(A, vizzy, { connectionId: id, stream: "search_performance", from: "2026-11-10", to: "2026-11-10" }, deps());
    await disconnect(A, admin, id, deps());
    await purgeConnections(A, { apply: true, by: "ops", addressesOnly: true, db, transport, appToken: async () => "made-up-app-token", log: () => {} });
    expect(ops.length).toBeGreaterThan(0);
    for (const op of ops) expect(op, op).toMatch(/^where \w+ ==$/);
  });
});
