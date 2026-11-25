import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { __resetRateLimitState } from "@/lib/tenant/rateLimit";

// Sign in with Google for an organisation (Connectors 3), through the organisation's start routes
// and the one callback every sign in uses. Fernhill Group [made up]: Fernhill Plants (Europe) and
// Fernhill US (United States); Priya and Alex own it. Google is a stub: the global fetch answers
// the token exchange and Search Console's sites list, by address.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn(), getAdminContextWithHome: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const dbs = vi.hoisted(() => ({ map: {} as Record<string, unknown> }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: (id = "(default)") => dbs.map[id],
}));

const list = await import("./route");
const again = await import("./[sourceId]/start/route");
const callbackRoute = await import("../../connectors/callback/route");
const brandStart = await import("../../connectors/[connectorId]/start/route");
const { createOrganisationConnection, forTenant, getOrganisationConnection, givePart } = await import("@/lib/tenant");
const { openConnectorSecret, sealConnectorSecret } = await import("@/lib/connectors/vault");

const ORIGIN = "https://app.yougrow.test";
const ORG = "org_ten_fernhill";
const EU = "ten_fernhill";
const US = "ten_fernhill-us";
const T0 = "2026-11-24T10:00:00.000Z";
const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SITES_URL = "https://searchconsole.googleapis.com/webmasters/v3/sites";
const priya = { tenantId: EU, region: "eu", source: "idtoken", userId: "usr_priya", role: "admin" };
const alex = { ...priya, userId: "usr_alex" };

let us: FakeFirestore;
let eu: FakeFirestore;
let sites: string[];
let fetchMock: ReturnType<typeof vi.fn>;
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const regionDb = (r: string) => (r === "eu" ? eu : us);
const signedInAs = (ctx: typeof priya) => {
  session.getAdminContext.mockResolvedValue(ctx);
  session.getAdminContextWithHome.mockResolvedValue({ ctx, homeTenantId: EU, homeRole: "admin" });
};

function seed() {
  for (const [id, name, region] of [
    [EU, "Fernhill Plants", "eu"],
    [US, "Fernhill US", "us"],
  ] as const) {
    us.seed("tenants", id, { tenantName: name, rootDomain: `${id.replace("ten_", "")}.example`, ownerId: "usr_priya", status: "active", region, allowedOrigins: [], createdAt: T0, updatedAt: T0, organisationId: ORG });
  }
  us.seed("organisations", ORG, { name: "Fernhill Group", plan: "ultra", planSince: T0, brandIds: [EU, US], ownerIds: ["usr_priya", "usr_alex"], createdBy: "usr_priya", createdAt: T0, updatedAt: T0 });
  us.seed("tenant_users", "alex-eu", { userId: "usr_alex", tenantId: EU, role: "admin", joinedAt: T0 });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimitState();
  us = new FakeFirestore();
  eu = new FakeFirestore();
  dbs.map = { "(default)": us, "signups-eu": eu, "signups-asia": new FakeFirestore() };
  seed();
  sites = ["sc-domain:fernhill.example", "sc-domain:fernhill-us.example"];
  fetchMock = vi.fn(async (url: string | URL) => {
    if (String(url) === TOKEN_URL) return answer({ access_token: "made-up-access", refresh_token: "made-up-refresh", expires_in: 3599, scope: SCOPE, token_type: "Bearer" });
    if (String(url) === SITES_URL) return answer({ siteEntry: sites.map((siteUrl) => ({ siteUrl, permissionLevel: "siteOwner" })) });
    return answer({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("CONNECTORS_ENABLED", "true");
  vi.stubEnv("PLANS_ENABLED", "true");
  vi.stubEnv("CONNECTORS_SHARING_ENABLED", "true");
  vi.stubEnv("CONNECTOR_SEARCH_CONSOLE_ENABLED", "true");
  vi.stubEnv("CONNECTORS_VAULT_KEY", "org-sign-in-test-vault-root-0123456789a");
  vi.stubEnv("CONNECTOR_GOOGLE_CLIENT_ID", "made-up-client.example.test");
  vi.stubEnv("CONNECTOR_GOOGLE_CLIENT_SECRET", "made-up-client-secret");
  vi.stubEnv("CONNECTORS_OAUTH_ORIGIN", ORIGIN);
  signedInAs(priya);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const post = (path: string, body?: unknown) =>
  new Request(`${ORIGIN}/api/admin/organisation/connections${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", host: "app.yougrow.test" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function started(res: Response) {
  expect(res.status).toBe(200);
  const url = new URL(((await res.json()) as { url: string }).url);
  return { state: url.searchParams.get("state")!, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0]! };
}
const callback = (s: { state: string; cookie: string }) =>
  callbackRoute.GET(new Request(`${ORIGIN}/api/admin/connectors/callback?${new URLSearchParams({ state: s.state, code: "made-up-code" })}`, { headers: { host: "app.yougrow.test", cookie: s.cookie } }));
const where = (res: Response) => new URL(res.headers.get("location") ?? "", ORIGIN);
const exchanges = () => fetchMock.mock.calls.filter((c) => String(c[0]) === TOKEN_URL).length;
const changes = () => Object.values(us.dump("organisation_changes")) as Array<Record<string, unknown>>;

describe("signing in with Google for the organisation", () => {
  it("keeps the sign in in the owner's brand's region, sealed for the organisation, with them as its signer", async () => {
    const s = await started(await list.POST(post("", { connectorId: "search-console", method: "oauth_pkce" })));
    const states = Object.values(eu.dump("data_connection_states")) as Array<Record<string, unknown>>;
    expect(states).toEqual([expect.objectContaining({ tenantId: EU, organisationId: ORG, sourceId: null, uid: "usr_priya" })]);
    const res = await callback(s);
    expect(res.status).toBe(303);
    const to = where(res);
    expect(to.pathname).toBe("/admin/account/organisation");
    expect(to.searchParams.get("status")).toBe("connected");
    const id = to.searchParams.get("connection")!;
    expect(id).toMatch(/^ocn_/);
    const rec = (await getOrganisationConnection(ORG, id, "eu", { regionDb: regionDb as never }))!;
    expect(rec).toMatchObject({ method: "oauth_pkce", signerUid: "usr_priya", createdBy: "usr_priya", connectedFromTenantId: EU, region: "eu", parts: [] });
    expect(openConnectorSecret(ORG, id, "refresh", rec.secrets.refresh!)).toBe("made-up-refresh");
    // No brand record is made: nothing is read until an owner gives a brand its part.
    expect(Object.keys(eu.dump("data_connections"))).toHaveLength(0);
    expect(Object.keys(us.dump("organisation_connections"))).toHaveLength(0);
    expect(changes()).toEqual([expect.objectContaining({ kind: "connection.connected", connectionId: id, tenantId: EU, actor: "usr_priya" })]);
  });

  it("refuses at the callback, before Google is asked, someone who stopped being an owner", async () => {
    const s = await started(await list.POST(post("", { connectorId: "search-console", method: "oauth_pkce" })));
    us.seed("organisations", ORG, { name: "Fernhill Group", plan: "ultra", planSince: T0, brandIds: [EU, US], ownerIds: ["usr_alex"], createdBy: "usr_priya", createdAt: T0, updatedAt: T0 });
    const res = await callback(s);
    expect(where(res).searchParams.get("reason")).toBe("not_owner");
    expect(where(res).pathname).toBe("/admin/account/connections/search-console");
    expect(exchanges()).toBe(0);
    expect(Object.keys(eu.dump("organisation_connections"))).toHaveLength(0);
  });

  it("refuses one whose brand left the organisation meanwhile, and one with sharing turned off", async () => {
    const s = await started(await list.POST(post("", { connectorId: "search-console", method: "oauth_pkce" })));
    us.seed("tenants", EU, { tenantName: "Fernhill Plants", rootDomain: "fernhill.example", ownerId: "usr_priya", status: "active", region: "eu", allowedOrigins: [], createdAt: T0, updatedAt: T0, organisationId: "org_ten_elsewhere" });
    expect(where(await callback(s)).searchParams.get("reason")).toBe("not_owner");
    seed();
    const s2 = await started(await list.POST(post("", { connectorId: "search-console", method: "oauth_pkce" })));
    vi.stubEnv("CONNECTORS_SHARING_ENABLED", "false");
    expect(where(await callback(s2)).searchParams.get("reason")).toBe("sharing_off");
    expect(exchanges()).toBe(0);
  });

  it("sends an owner whose sign in for the organisation didn't finish back to Settings › Organisation, saying why", async () => {
    const s = await started(await list.POST(post("", { connectorId: "search-console", method: "oauth_pkce" })));
    const res = await callbackRoute.GET(
      new Request(`${ORIGIN}/api/admin/connectors/callback?${new URLSearchParams({ state: s.state, error: "access_denied" })}`, { headers: { host: "app.yougrow.test", cookie: s.cookie } }),
    );
    expect(where(res).pathname).toBe("/admin/account/organisation");
    expect(where(res).searchParams.get("status")).toBe("error");
    expect(where(res).searchParams.get("reason")).toBe("denied");
    expect(Object.keys(eu.dump("organisation_connections"))).toHaveLength(0);
  });

  it("refuses a new sign in once the organisation holds 20 connections for the connector, in every region together", async () => {
    const { id: _id, ...doc } = {
      id: "",
      organisationId: ORG,
      region: "eu",
      connectorId: "search-console",
      method: "token_fields",
      label: "Search Console",
      createdBy: "usr_priya",
      signerUid: null,
      connectedFromTenantId: EU,
      secrets: {},
      health: { state: "ok", lastOkAt: T0, lastCheckedAt: T0, lastErrorCode: null, failures: 0, pausedUntil: null },
      pausedAt: null,
      pausedBy: null,
      status: "connected",
      createdAt: T0,
      updatedAt: T0,
      disconnectedAt: null,
      collectHold: null,
      parts: [],
      recent: [],
    };
    for (let i = 0; i < 20; i++) (i % 2 ? us : eu).seed("organisation_connections", `ocn_${"c".repeat(18)}${"abcdefghijklmnopqrst"[i]}a`, { ...doc, region: i % 2 ? "us" : "eu" });
    const res = await list.POST(post("", { connectorId: "search-console", method: "oauth_pkce" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "org_connection_limit" });
  });

  it("finishes a brand's own sign in as the brand's, never as the organisation's", async () => {
    const res = await brandStart.POST(new Request(`${ORIGIN}/api/admin/connectors/search-console/start`, { method: "POST", headers: { "content-type": "application/json", host: "app.yougrow.test" }, body: "{}" }), {
      params: Promise.resolve({ connectorId: "search-console" }),
    });
    const s = await started(res);
    const done = await callback(s);
    expect(where(done).pathname).toBe("/admin/account/connections/search-console");
    expect(Object.keys(eu.dump("organisation_connections"))).toHaveLength(0);
    expect(Object.keys(eu.dump("data_connections"))).toHaveLength(1);
  });
});

describe("signing in again for the organisation", () => {
  const SRC = "ocn_ssssssssssssssssssss";
  const health = { state: "ok" as const, lastOkAt: T0, lastCheckedAt: T0, lastErrorCode: null, failures: 0, pausedUntil: null };

  beforeEach(async () => {
    await createOrganisationConnection(
      {
        id: SRC,
        organisationId: ORG,
        region: "eu",
        connectorId: "search-console",
        method: "oauth_pkce",
        label: "Google Search Console",
        createdBy: "usr_priya",
        signerUid: "usr_priya",
        connectedFromTenantId: EU,
        secrets: {
          access: sealConnectorSecret(ORG, SRC, "access", "made-up-old-access", new Date(T0)),
          refresh: sealConnectorSecret(ORG, SRC, "refresh", "made-up-old-refresh", new Date(T0)),
        },
        tokenExpiresAt: "2026-11-24T11:00:00.000Z",
        health,
        pausedAt: null,
        pausedBy: null,
        status: "connected",
        createdAt: T0,
        updatedAt: T0,
        disconnectedAt: null,
        collectHold: null,
        parts: [],
      },
      [{ kind: "connected", by: "usr_priya", at: T0 }],
      { regionDb: regionDb as never },
    );
    for (const [brand, region, useId, account] of [
      [EU, "eu", "dcn_eeeeeeeeeeeeeeeeeeee", "sc-domain:fernhill.example"],
      [US, "us", "dcn_uuuuuuuuuuuuuuuuuuuu", "sc-domain:fernhill-us.example"],
    ] as const) {
      const r = await givePart(
        {
          source: { organisationId: ORG, connectionId: SRC, region: "eu" },
          brand: { tenantId: brand, region },
          record: { id: useId, connectorId: "search-console", method: "oauth_pkce", label: "Google Search Console", account, ownerUid: "usr_priya", grants: [], secrets: {}, health, pausedAt: null, pausedBy: null, status: "connected", createdAt: T0, updatedAt: T0, disconnectedAt: null },
          recordActivity: [{ kind: "connected", by: "usr_priya", at: T0, code: "part_given" }],
          by: "usr_priya",
          at: T0,
        },
        { regionDb: regionDb as never },
      );
      expect(r.ok).toBe(true);
    }
  });

  it("by another owner replaces the tokens in place, makes them the signer, and marks only the part they can't read, on its own brand", async () => {
    signedInAs(alex);
    // Alex's Google account sees Fernhill Plants' site, not Fernhill US's.
    sites = ["sc-domain:fernhill.example"];
    const s = await started(await again.POST(post(`/${SRC}/start`), { params: Promise.resolve({ sourceId: SRC }) }));
    const res = await callback(s);
    const to = where(res);
    expect(to.pathname).toBe("/admin/account/organisation");
    expect(Object.fromEntries(to.searchParams)).toEqual({ status: "signed_in_again", connection: SRC, unreadable: "1" });
    const rec = (await getOrganisationConnection(ORG, SRC, "eu", { regionDb: regionDb as never }))!;
    expect(rec.signerUid).toBe("usr_alex");
    expect(openConnectorSecret(ORG, SRC, "refresh", rec.secrets.refresh!)).toBe("made-up-refresh");
    expect(rec.parts.map((p) => p.state)).toEqual(["active", "active"]);
    const usPart = await forTenant({ tenantId: US, region: "us", source: "system" }, us).dataConnections.getById("dcn_uuuuuuuuuuuuuuuuuuuu");
    const euPart = await forTenant({ tenantId: EU, region: "eu", source: "system" }, eu).dataConnections.getById("dcn_eeeeeeeeeeeeeeeeeeee");
    expect(usPart!.health).toMatchObject({ state: "broken", lastErrorCode: "account_refused" });
    expect(euPart!.health.state).toBe("ok");
    expect(changes()).toEqual([expect.objectContaining({ kind: "connection.signed_in_again", connectionId: SRC, actor: "usr_alex" })]);
  });

  it("refuses another organisation's connection id", async () => {
    const r = await again.POST(post("/ocn_zzzzzzzzzzzzzzzzzzzz/start"), { params: Promise.resolve({ sourceId: "ocn_zzzzzzzzzzzzzzzzzzzz" }) });
    expect(r.status).toBe(404);
  });
});
