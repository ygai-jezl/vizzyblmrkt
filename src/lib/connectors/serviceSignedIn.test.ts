import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { createDataConnection, forTenant, type TenantContext } from "@/lib/tenant";
import type { ConnectorActor } from "./grants";
import { healthyAt } from "./health";
import { check, disconnect, getForActor, listAccounts, listForActor, pickAccount, readLiveFor, REVOKED_MESSAGE } from "./service";
import { ACCESS_SLOT, REFRESH_SLOT } from "./tokenKeeper";
import { openConnectorSecret, sealConnectorSecret } from "./vault";

// A Search Console connection signed in with Google, through the service: the token keeper's
// refresh, the site picker and the live read. Google is never called: every request goes to a
// stub transport that answers by address.
const A: TenantContext = { tenantId: "ten_a", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const admin: ConnectorActor = { kind: "human", uid: "usr_admin", role: "admin" };
const member: ConnectorActor = { kind: "human", uid: "usr_member", role: "member" };
const ID = "dcn_aaaaaaaaaaaaaaaaaaaa";
const OTHER = "dcn_bbbbbbbbbbbbbbbbbbbb";
const NOW = new Date("2026-11-21T10:00:00.000Z");
const inMs = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const SITES_URL = "https://searchconsole.googleapis.com/webmasters/v3/sites";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const SITES = {
  siteEntry: [
    { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
    { siteUrl: "https://unverified.example.test/", permissionLevel: "siteUnverifiedUser" },
  ],
};
const ROWS = { rows: [{ keys: ["2026-11-10"], clicks: 5, impressions: 100, ctr: 0.05, position: 6.5 }] };

let db: FakeFirestore;
let transport: ReturnType<typeof vi.fn>;
let tokenAnswer: () => Response;
let revokeAnswer: () => Response;
const deps = () => ({ db, transport, limit: async () => false, log: () => {}, now: NOW, sleep: async () => {} });
const calls = () => transport.mock.calls.map((c) => String(c[0]));
const authOf = (i: number) => ((transport.mock.calls[i]![1] as RequestInit).headers as Record<string, string>).authorization;
const load = async (id = ID) => (await forTenant(A, db).dataConnections.getById(id))!;
const activity = () => db.dump("data_connection_activity").map((a) => `${a.kind}${a.code ? `:${a.code}` : ""}`);

async function seed(over: { id?: string; account?: string; expiresAt?: string } = {}) {
  const id = over.id ?? ID;
  const at = new Date(NOW.getTime() - 3_600_000);
  await createDataConnection(
    A,
    {
      id,
      connectorId: "search-console",
      method: "oauth_pkce",
      label: "Google Search Console",
      account: over.account ?? "",
      ownerUid: "usr_admin",
      grants: [],
      secrets: {
        [ACCESS_SLOT]: sealConnectorSecret("ten_a", id, ACCESS_SLOT, "made-up-old-access", at),
        [REFRESH_SLOT]: sealConnectorSecret("ten_a", id, REFRESH_SLOT, "made-up-refresh", at),
      },
      tokenExpiresAt: over.expiresAt ?? inMs(30 * 60_000),
      refresh: { leaseId: null, leaseUntil: null },
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

beforeEach(() => {
  db = new FakeFirestore();
  tokenAnswer = () => answer({ access_token: "made-up-new-access", expires_in: 3599, scope: "https://www.googleapis.com/auth/webmasters.readonly", token_type: "Bearer" });
  revokeAnswer = () => new Response(null, { status: 200 });
  transport = vi.fn(async (url: string) => {
    if (url === TOKEN_URL) return tokenAnswer();
    if (url === REVOKE_URL) return revokeAnswer();
    if (url === SITES_URL) return answer(SITES);
    if (url.endsWith("/searchAnalytics/query")) return answer(ROWS);
    return answer({}, 404);
  });
  vi.stubEnv("CONNECTORS_ENABLED", "true");
  vi.stubEnv("CONNECTOR_SEARCH_CONSOLE_ENABLED", "true");
  vi.stubEnv("CONNECTORS_VAULT_KEY", "signed-in-test-vault-root-0123456789abcd");
  vi.stubEnv("CONNECTOR_GOOGLE_CLIENT_ID", "made-up-client.example.test");
  vi.stubEnv("CONNECTOR_GOOGLE_CLIENT_SECRET", "made-up-client-secret");
});
afterEach(() => vi.unstubAllEnvs());

describe("a signed in connection with no site picked", () => {
  it("says it needs one, and refuses a live read before calling Google", async () => {
    await seed();
    const view = await getForActor(A, admin, ID, deps());
    expect(view).toMatchObject({ ok: true, value: { needsAccount: true, canReadLive: false } });
    expect(await readLiveFor(A, admin, ID, { stream: "search_performance", from: "2026-11-01", to: "2026-11-10" }, deps())).toMatchObject({
      ok: false,
      status: 409,
      error: "account_needed",
      message: "Pick which site or property this connection reads first.",
    });
    expect(transport).not.toHaveBeenCalled();
    expect((await load()).health.state).toBe("ok");
  });

  it("lists the sites the sign in sees for an admin, unverified ones left out, storing nothing", async () => {
    await seed();
    expect(await listAccounts(A, admin, ID, deps())).toEqual({
      ok: true,
      status: 200,
      value: { accounts: [{ id: "sc-domain:example.com", label: "example.com (whole domain)", detail: "Owner" }], more: false, current: "" },
    });
    expect(authOf(0)).toBe("Bearer made-up-old-access");
    expect(await listAccounts(A, member, ID, deps())).toMatchObject({ ok: false, status: 403 });
    expect((await load()).account).toBe("");
  });

  it("lets an admin pick a verified site, recorded as account_picked, and then reads it", async () => {
    await seed();
    const picked = await pickAccount(A, admin, ID, { account: "sc-domain:example.com" }, deps());
    expect(picked).toMatchObject({ ok: true, value: { needsAccount: false, canReadLive: true, details: { account: "sc-domain:example.com" } } });
    expect(activity()).toEqual(["connected", "account_picked"]);
    const live = await readLiveFor(A, admin, ID, { stream: "search_performance", from: "2026-11-01", to: "2026-11-10" }, deps());
    expect(live).toMatchObject({
      ok: true,
      value: {
        connectorId: "search-console",
        rows: [{ day: "2026-11-10", searchClicks: 5, searchImpressions: 100, searchCtr: 0.05, searchPosition: 6.5 }],
        meanings: { searchClicks: { name: "Search clicks" }, searchPosition: { unit: "rank" } },
        lag: { days: 3 },
      },
    });
    expect(calls().at(-1)).toBe("https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query");
  });

  it("refuses a site the sign in can't see, a member, a pasted token connection and a site another connection reads", async () => {
    await seed();
    expect(await pickAccount(A, admin, ID, { account: "https://unverified.example.test/" }, deps())).toMatchObject({ ok: false, status: 400, error: "account_refused" });
    expect(await pickAccount(A, member, ID, { account: "sc-domain:example.com" }, deps())).toMatchObject({ ok: false, status: 403 });
    expect(await pickAccount(A, admin, ID, { nope: 1 }, deps())).toMatchObject({ ok: false, status: 400, error: "invalid_input" });
    expect((await load()).health.state).toBe("ok");
    await seed({ id: OTHER, account: "sc-domain:example.com" });
    expect(await pickAccount(A, admin, ID, { account: "sc-domain:example.com" }, deps())).toMatchObject({ ok: false, status: 409, error: "already_connected" });
    expect((await load()).account).toBe("");
  });
});

describe("a signed in connection's token", () => {
  it("is refreshed by the keeper before a live read once it is due, and the new one is used", async () => {
    await seed({ account: "sc-domain:example.com", expiresAt: inMs(60_000) });
    const r = await readLiveFor(A, admin, ID, { stream: "search_performance", from: "2026-11-01", to: "2026-11-10" }, deps());
    expect(r.ok).toBe(true);
    expect(calls()).toEqual([TOKEN_URL, "https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query"]);
    expect(authOf(1)).toBe("Bearer made-up-new-access");
    const conn = await load();
    expect(openConnectorSecret("ten_a", ID, ACCESS_SLOT, conn.secrets[ACCESS_SLOT]!)).toBe("made-up-new-access");
    expect(JSON.stringify(r)).not.toContain("made-up");
  });

  it("marks the connection broken once when Google ends the sign in, and says to reconnect", async () => {
    await seed({ account: "sc-domain:example.com", expiresAt: inMs(-60_000) });
    tokenAnswer = () => answer({ error: "invalid_grant" }, 400);
    const r = await check(A, admin, ID, deps());
    expect(r).toMatchObject({ ok: false, status: 409, error: "signin_refused", message: expect.stringContaining("Reconnect") });
    expect((await load()).health).toMatchObject({ state: "broken", lastErrorCode: "signin_refused" });
    expect(activity()).toEqual(["connected", "failed:signin_refused"]);
    const listed = await listForActor(A, admin, deps());
    expect(listed.ok && listed.value.connections[0]!.health).toMatchObject({ state: "broken", message: expect.stringContaining("sign in again") });
  });

  it("records a soft failure as check when Google is down and the token has run out", async () => {
    await seed({ account: "sc-domain:example.com", expiresAt: inMs(-60_000) });
    tokenAnswer = () => answer({}, 503);
    expect(await check(A, admin, ID, deps())).toMatchObject({ ok: false, status: 502, error: "provider_error" });
    expect((await load()).health).toMatchObject({ state: "check", lastErrorCode: "provider_error", failures: 1 });
  });

  it("is refused while this copy has no Google client: the connector is off", async () => {
    await seed({ account: "sc-domain:example.com" });
    vi.stubEnv("CONNECTOR_GOOGLE_CLIENT_ID", "");
    expect(await readLiveFor(A, admin, ID, { stream: "search_performance", from: "2026-11-01", to: "2026-11-10" }, deps())).toMatchObject({ ok: false, status: 404, error: "connector_off" });
    expect(transport).not.toHaveBeenCalled();
  });
});

describe("disconnecting a signed in connection", () => {
  it("deletes the tokens and leaves the grant at Google while the revoke switch is off", async () => {
    await seed({ account: "sc-domain:example.com" });
    const r = await disconnect(A, admin, ID, deps());
    expect(r).toMatchObject({ ok: true, value: { revoked: false, message: expect.stringContaining("third party connections"), connection: { status: "disconnected" } } });
    expect(transport).not.toHaveBeenCalled();
    expect((await load()).secrets).toEqual({});
  });

  it("revokes the refresh token at Google after saving, with the switch on, and says what that ends", async () => {
    await seed({ account: "sc-domain:example.com" });
    vi.stubEnv("CONNECTOR_GOOGLE_REVOKE_ENABLED", "true");
    const r = await disconnect(A, admin, ID, deps());
    expect(r).toMatchObject({ ok: true, value: { revoked: true, message: REVOKED_MESSAGE } });
    expect(calls()).toEqual([REVOKE_URL]);
    expect(String((transport.mock.calls[0]![1] as RequestInit).body)).toBe("token=made-up-refresh");
    expect((await load()).secrets).toEqual({});
    expect(activity()).toEqual(["connected", "disconnected"]);
  });

  it("still disconnects when Google's revoke fails, and never revokes twice or for a member", async () => {
    await seed({ account: "sc-domain:example.com" });
    vi.stubEnv("CONNECTOR_GOOGLE_REVOKE_ENABLED", "true");
    revokeAnswer = () => answer({ error: "invalid_token" }, 400);
    expect(await disconnect(A, member, ID, deps())).toMatchObject({ ok: false, status: 403 });
    expect(await disconnect(A, admin, ID, deps())).toMatchObject({ ok: true, value: { revoked: false, connection: { status: "disconnected" } } });
    expect(await disconnect(A, admin, ID, deps())).toMatchObject({ ok: true, value: { revoked: false } });
    expect(calls()).toEqual([REVOKE_URL]);
  });
});
