import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { timestampFirestore } from "@/lib/tenant/testing/timestampFirestore";
import { __resetRateLimitState } from "@/lib/tenant/rateLimit";
import { __resetShareTokens } from "@/lib/connectors/shareAccess";

// The search databases: an in-memory index, since Disconnect erases a part's searches.
vi.mock("@/lib/tenant/searchIndex", async () => {
  const { MemorySearchIndex } = await import("@/lib/search/memoryStore");
  const index = new MemorySearchIndex();
  return { searchStoreFor: (ctx: { tenantId: string }) => index.storeFor(ctx) };
});

// The organisation connection routes (Connectors 3): Settings › Organisation's list, connecting
// for the organisation, pause, check access and Disconnect. Fernhill Group [made up] has Fernhill
// Plants (Europe) and Fernhill US (United States); Priya owns it, reaches Fernhill Plants as her
// home brand (claims, no tenant_users row) and Fernhill US by an admin row. Leo is an admin of
// Fernhill Plants who isn't an owner; Sam is a member. One fake database per region, with
// (default) the United States one. No provider is called: the global fetch plays Cloudflare and IAM.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn(), getAdminContextWithHome: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const dbs = vi.hoisted(() => ({ map: {} as Record<string, unknown> }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: (id = "(default)") => dbs.map[id],
}));
vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    async getAccessToken() {
      return "made-up-app-token";
    }
  },
}));

const list = await import("./route");
const one = await import("./[sourceId]/route");
const pause = await import("./[sourceId]/pause/route");
const access = await import("./[sourceId]/access/route");
const { forTenant, getOrganisationConnection, givePart } = await import("@/lib/tenant");
const { openConnectorSecret, sealConnectorSecret, VaultOpenError } = await import("@/lib/connectors/vault");

const ORIGIN = "https://app.yougrow.test";
const PROJECT = "made-up-identities";
const ORG = "org_ten_fernhill";
const OTHER = "org_ten_other";
const EU = "ten_fernhill";
const US = "ten_fernhill-us";
const T0 = "2026-11-24T10:00:00.000Z";
const ZONE_A = "0123456789abcdef0123456789abcd01";
const ZONE_B = "0123456789abcdef0123456789abcd02";

const priya = { tenantId: EU, region: "eu", source: "idtoken", userId: "usr_priya", role: "admin" };
const priyaInUs = { tenantId: US, region: "us", source: "idtoken", userId: "usr_priya", role: "admin" };
const leo = { tenantId: EU, region: "eu", source: "idtoken", userId: "usr_leo", role: "admin" };
const sam = { tenantId: EU, region: "eu", source: "idtoken", userId: "usr_sam", role: "member" };
const as = (ctx: Record<string, unknown>, home = EU, homeRole: "admin" | "member" = "admin") => session.getAdminContextWithHome.mockResolvedValue({ ctx, homeTenantId: home, homeRole });

let us: FakeFirestore;
let eu: FakeFirestore;
let asia: FakeFirestore;
let fetchMock: ReturnType<typeof vi.fn>;
let zones: Array<{ id: string; name: string; status: string }>;
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const regionDb = (r: string) => (r === "eu" ? eu : r === "asia" ? asia : us);

function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/api/admin/organisation/connections${path}`, {
    method,
    headers: { "content-type": "application/json", host: "app.yougrow.test", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const p = (sourceId: string) => ({ params: Promise.resolve({ sourceId }) });

function seed() {
  const tenant = (id: string, name: string, region: string, organisationId: string) =>
    us.seed("tenants", id, { tenantName: name, rootDomain: `${id.replace("ten_", "")}.example`, ownerId: "usr_priya", status: "active", region, allowedOrigins: [], createdAt: T0, updatedAt: T0, organisationId });
  tenant(EU, "Fernhill Plants", "eu", ORG);
  tenant(US, "Fernhill US", "us", ORG);
  tenant("ten_other", "Other Shop", "eu", OTHER);
  us.seed("organisations", ORG, { name: "Fernhill Group", plan: "ultra", planSince: T0, brandIds: [EU, US], ownerIds: ["usr_priya"], createdBy: "usr_priya", createdAt: T0, updatedAt: T0 });
  us.seed("organisations", OTHER, { name: "Other Group", plan: "ultra", planSince: T0, brandIds: ["ten_other"], ownerIds: ["usr_otto"], createdBy: "usr_otto", createdAt: T0, updatedAt: T0 });
  us.seed("tenant_users", "usr_priya_ten_fernhill-us", { userId: "usr_priya", tenantId: US, role: "admin", joinedAt: T0 });
  us.seed("tenant_users", "usr_leo_ten_fernhill", { userId: "usr_leo", tenantId: EU, role: "admin", joinedAt: T0 });
}

const health = { state: "ok" as const, lastOkAt: T0, lastCheckedAt: T0, lastErrorCode: null, failures: 0, pausedUntil: null };
async function seedOrgToken(id: string, organisationId = ORG, region: "eu" | "us" = "eu") {
  const { createOrganisationConnection } = await import("@/lib/tenant");
  await createOrganisationConnection(
    {
      id,
      organisationId,
      region,
      connectorId: "cloudflare",
      method: "token_fields",
      label: "Cloudflare",
      createdBy: "usr_priya",
      signerUid: null,
      connectedFromTenantId: EU,
      secrets: { token: sealConnectorSecret(organisationId, id, "token", "made-up-org-token", new Date(T0)) },
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
  return { organisationId, connectionId: id, region };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimitState();
  __resetShareTokens();
  us = new FakeFirestore();
  eu = new FakeFirestore();
  asia = new FakeFirestore();
  dbs.map = { "(default)": us, "signups-eu": eu, "signups-asia": asia };
  seed();
  zones = [
    { id: ZONE_A, name: "fernhill.example", status: "active" },
    { id: ZONE_B, name: "fernhill-us.example", status: "active" },
  ];
  let n = 7000;
  fetchMock = vi.fn(async (url: string | URL, init: RequestInit) => {
    const u = new URL(String(url));
    if (u.hostname === "api.cloudflare.com" && u.pathname === "/client/v4/zones") return answer({ success: true, result: zones, result_info: { total_pages: 1 } });
    if (u.hostname === "iam.googleapis.com" && init.method === "POST") {
      const body = JSON.parse(String(init.body));
      return answer({ email: `${body.accountId}@${PROJECT}.iam.gserviceaccount.com`, uniqueId: String(n++) });
    }
    if (u.hostname === "iam.googleapis.com" && init.method === "DELETE") return answer({});
    if (u.hostname === "iamcredentials.googleapis.com") return answer({ accessToken: "made-up-minted", expireTime: new Date(Date.now() + 300_000).toISOString() });
    if (u.hostname === "searchconsole.googleapis.com") return answer({ siteEntry: [{ siteUrl: "sc-domain:fernhill.example", permissionLevel: "siteRestrictedUser" }] });
    return answer({}, 500);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("CONNECTORS_ENABLED", "true");
  vi.stubEnv("PLANS_ENABLED", "true");
  vi.stubEnv("CONNECTORS_SHARING_ENABLED", "true");
  vi.stubEnv("CONNECTOR_CLOUDFLARE_ENABLED", "true");
  vi.stubEnv("CONNECTOR_SEARCH_CONSOLE_ENABLED", "true");
  vi.stubEnv("CONNECTORS_VAULT_KEY", "org-routes-test-vault-root-0123456789ab");
  vi.stubEnv("CONNECTORS_IDENTITIES_PROJECT", PROJECT);
  as(priya);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const changes = () => Object.values(us.dump("organisation_changes")) as Array<Record<string, unknown>>;

describe("the organisation connection routes: who gets in", () => {
  it("answer 404 with sharing off, or with plans or connectors off, before reading the session", async () => {
    for (const off of ["CONNECTORS_SHARING_ENABLED", "PLANS_ENABLED", "CONNECTORS_ENABLED"]) {
      vi.stubEnv(off, "false");
      expect((await list.GET(req("GET", ""))).status).toBe(404);
      vi.stubEnv(off, "true");
    }
    expect(session.getAdminContextWithHome).not.toHaveBeenCalled();
  });

  it("refuse a cross-site request, a member, and an admin who isn't an owner", async () => {
    expect((await list.GET(req("GET", "", undefined, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }))).status).toBe(403);
    as(sam, EU, "member");
    expect((await list.GET(req("GET", ""))).status).toBe(403);
    as(leo, EU, "member");
    const r = await list.GET(req("GET", ""));
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: "not_owner" });
  });

  it("let an owner in from their home brand by its claims, and from another brand only with an admin row", async () => {
    const r = await list.GET(req("GET", ""));
    expect(r.status).toBe(200);
    const screen = (await r.json()) as { organisation: { id: string }; brands: Array<{ id: string; isAdmin: boolean; regionName: string }> };
    expect(screen.organisation.id).toBe(ORG);
    expect(screen.brands.map((b) => [b.id, b.isAdmin, b.regionName])).toEqual([
      [EU, true, "Europe"],
      [US, true, "United States"],
    ]);
    // In Fernhill US, a switched brand: her row says admin. Without it she is refused there.
    as(priyaInUs);
    expect((await list.GET(req("GET", ""))).status).toBe(200);
    us.seed("tenant_users", "usr_priya_ten_fernhill-us", { userId: "usr_priya", tenantId: US, role: "member", joinedAt: T0 });
    expect((await list.GET(req("GET", ""))).status).toBe(403);
  });

  it("never take the organisation or a region from the request", async () => {
    const r = await list.POST(req("POST", "", { connectorId: "cloudflare", method: "token_fields", fields: { token: "made-up-org-token-0123456789" }, organisationId: OTHER, region: "asia" }));
    expect(r.status).toBe(400);
    expect(Object.keys(eu.dump("organisation_connections"))).toHaveLength(0);
    expect(Object.keys(asia.dump("organisation_connections"))).toHaveLength(0);
  });
});

describe("connecting a Cloudflare token for the organisation", () => {
  it("lists the zones it reaches, seals it for the organisation, keeps it in the owner's brand's region and logs it", async () => {
    const r = await list.POST(req("POST", "", { connectorId: "cloudflare", method: "token_fields", fields: { token: "made-up-org-token-0123456789" } }));
    expect(r.status).toBe(201);
    const { connectionId, reaches } = (await r.json()) as { connectionId: string; reaches: number };
    expect(connectionId).toMatch(/^ocn_[a-z2-7]{20}$/);
    expect(reaches).toBe(2);
    expect(Object.keys(us.dump("organisation_connections"))).toHaveLength(0);
    const rec = (await getOrganisationConnection(ORG, connectionId, "eu", { regionDb: regionDb as never }))!;
    expect(rec).toMatchObject({ region: "eu", connectorId: "cloudflare", method: "token_fields", createdBy: "usr_priya", signerUid: null, connectedFromTenantId: EU, parts: [] });
    expect(openConnectorSecret(ORG, connectionId, "token", rec.secrets.token!)).toBe("made-up-org-token-0123456789");
    // A blob sealed for the organisation never opens as a brand's.
    expect(() => openConnectorSecret(EU, connectionId, "token", rec.secrets.token!)).toThrow(VaultOpenError);
    // Only ids on the organisation's change log, in (default).
    const logged = changes();
    expect(logged).toEqual([expect.objectContaining({ organisationId: ORG, kind: "connection.connected", connectionId, tenantId: EU, actor: "usr_priya" })]);
    expect(JSON.stringify(logged)).not.toContain("made-up-org-token");
    // Cloudflare was asked with the pasted token, and nothing was saved under a brand.
    expect(Object.keys(eu.dump("data_connections"))).toHaveLength(0);
  });

  it("refuses a token that reaches no zone, saving nothing", async () => {
    zones = [];
    const r = await list.POST(req("POST", "", { connectorId: "cloudflare", method: "token_fields", fields: { token: "made-up-org-token-0123456789" } }));
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: "cant_list" });
    expect(Object.keys(eu.dump("organisation_connections"))).toHaveLength(0);
    expect(changes()).toHaveLength(0);
  });

  it("keeps the connection when the change log can't be written", async () => {
    const create = vi.spyOn(us, "collection");
    create.mockImplementation(((name: string) => {
      if (name === "organisation_changes") throw new Error("made-up outage");
      return FakeFirestore.prototype.collection.call(us, name);
    }) as never);
    const r = await list.POST(req("POST", "", { connectorId: "cloudflare", method: "token_fields", fields: { token: "made-up-org-token-0123456789" } }));
    expect(r.status).toBe(201);
    expect(Object.keys(eu.dump("organisation_connections"))).toHaveLength(1);
  });
});

describe("a Google address for the organisation", () => {
  it("is tagged for the organisation, never the brand, kept in Europe, and the same one comes back while it waits", async () => {
    const first = await list.POST(req("POST", "", { connectorId: "search-console", method: "share_access" }));
    expect(first.status).toBe(201);
    const made = (await first.json()) as { connectionId: string; share: { email: string }; reused: boolean };
    expect(made.reused).toBe(false);
    const create = fetchMock.mock.calls.find((c) => String(c[0]).startsWith("https://iam.googleapis.com/") && (c[1] as RequestInit).method === "POST")!;
    const description = JSON.parse(String((create[1] as RequestInit).body)).serviceAccount.description as string;
    expect(description).toMatch(new RegExp(` connection=${made.connectionId} org=[0-9a-f]{16} copy=[0-9a-f]{16}$`));
    expect(description).not.toContain("brand=");
    expect((await getOrganisationConnection(ORG, made.connectionId, "eu", { regionDb: regionDb as never }))!.serviceAccount!.email).toBe(made.share.email);

    const again = await list.POST(req("POST", "", { connectorId: "search-console", method: "share_access" }));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ connectionId: made.connectionId, reused: true });

    const checked = await access.POST(req("POST", `/${made.connectionId}/access`), p(made.connectionId));
    expect(checked.status).toBe(200);
    expect(await checked.json()).toMatchObject({ visible: true, count: 1 });
    expect((await getOrganisationConnection(ORG, made.connectionId, "eu", { regionDb: regionDb as never }))!.health.state).toBe("ok");
  });
});

describe("pause, one connection and Disconnect", () => {
  it("find a connection by id in any region, and refuse another organisation's", async () => {
    const mine = await seedOrgToken("ocn_aaaaaaaaaaaaaaaaaaaa");
    await seedOrgToken("ocn_bbbbbbbbbbbbbbbbbbbb", OTHER, "us");
    expect((await one.GET(req("GET", `/${mine.connectionId}`), p(mine.connectionId))).status).toBe(200);
    expect((await one.GET(req("GET", "/ocn_bbbbbbbbbbbbbbbbbbbb"), p("ocn_bbbbbbbbbbbbbbbbbbbb"))).status).toBe(404);
    expect((await pause.POST(req("POST", "/ocn_bbbbbbbbbbbbbbbbbbbb/pause", { paused: true }), p("ocn_bbbbbbbbbbbbbbbbbbbb"))).status).toBe(404);
    expect((await one.DELETE(req("DELETE", "/ocn_bbbbbbbbbbbbbbbbbbbb"), p("ocn_bbbbbbbbbbbbbbbbbbbb"))).status).toBe(404);
    expect((await getOrganisationConnection(OTHER, "ocn_bbbbbbbbbbbbbbbbbbbb", "us", { regionDb: regionDb as never }))!.status).toBe("connected");
  });

  it("pause and resume for every brand, each logged on the organisation", async () => {
    const src = await seedOrgToken("ocn_aaaaaaaaaaaaaaaaaaaa");
    expect((await pause.POST(req("POST", `/${src.connectionId}/pause`, { paused: true }), p(src.connectionId))).status).toBe(200);
    expect((await getOrganisationConnection(ORG, src.connectionId, "eu", { regionDb: regionDb as never }))!).toMatchObject({ pausedBy: "usr_priya" });
    expect((await pause.POST(req("POST", `/${src.connectionId}/pause`, { paused: false }), p(src.connectionId))).status).toBe(200);
    expect((await getOrganisationConnection(ORG, src.connectionId, "eu", { regionDb: regionDb as never }))!.pausedAt).toBeNull();
    expect(changes().map((c) => c.kind)).toEqual(["connection.paused", "connection.resumed"]);
  });

  it("Disconnect ends a brand's part in the United States, marks it for erasing there, and logs it", async () => {
    const src = await seedOrgToken("ocn_aaaaaaaaaaaaaaaaaaaa");
    const given = await givePart(
      {
        source: src,
        brand: { tenantId: US, region: "us" },
        record: {
          id: "dcn_uuuuuuuuuuuuuuuuuuuu",
          connectorId: "cloudflare",
          method: "token_fields",
          label: "fernhill-us.example",
          account: ZONE_B,
          ownerUid: "usr_priya",
          grants: [],
          secrets: {},
          health,
          pausedAt: null,
          pausedBy: null,
          status: "connected",
          createdAt: T0,
          updatedAt: T0,
          disconnectedAt: null,
        },
        recordActivity: [{ kind: "connected", by: "usr_priya", at: T0, code: "part_given" }],
        by: "usr_priya",
        at: T0,
      },
      { regionDb: regionDb as never },
    );
    expect(given.ok).toBe(true);
    const r = await one.DELETE(req("DELETE", `/${src.connectionId}`), p(src.connectionId));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ended: 1, revoked: false, addressDeleted: null });
    const part = await forTenant({ tenantId: US, region: "us", source: "system" }, us).dataConnections.getById("dcn_uuuuuuuuuuuuuuuuuuuu");
    expect(part).toMatchObject({ status: "disconnected" });
    const rec = (await getOrganisationConnection(ORG, src.connectionId, "eu", { regionDb: regionDb as never }))!;
    expect(rec).toMatchObject({ status: "disconnected", secrets: {}, parts: [] });
    expect(changes().map((c) => c.kind)).toEqual(["connection.disconnected"]);
  });
});

describe("the list", () => {
  it("reads every region, says who signed in without a name, and reads each part's record in its brand's region with stored dates as Firestore keeps them", async () => {
    // Stored dates come back as Timestamps from real Firestore: the screen reads none as a Date.
    eu = timestampFirestore(eu);
    us = timestampFirestore(us);
    dbs.map = { "(default)": us, "signups-eu": eu, "signups-asia": asia };
    seed();
    const src = await seedOrgToken("ocn_aaaaaaaaaaaaaaaaaaaa");
    await seedOrgToken("ocn_cccccccccccccccccccc", ORG, "us");
    await givePart(
      {
        source: src,
        brand: { tenantId: US, region: "us" },
        record: {
          id: "dcn_uuuuuuuuuuuuuuuuuuuu",
          connectorId: "cloudflare",
          method: "token_fields",
          label: "fernhill-us.example",
          account: ZONE_B,
          ownerUid: "usr_priya",
          grants: [{ to: "members", can: "read" }],
          secrets: {},
          health,
          pausedAt: null,
          pausedBy: null,
          status: "connected",
          createdAt: T0,
          updatedAt: T0,
          disconnectedAt: null,
        },
        recordActivity: [{ kind: "connected", by: "usr_priya", at: T0, code: "part_given" }],
        by: "usr_priya",
        at: T0,
      },
      { regionDb: regionDb as never },
    );
    const r = await list.GET(req("GET", ""));
    expect(r.status).toBe(200);
    const screen = (await r.json()) as { connections: Array<{ id: string; regionName: string; signer: string | null; mine: boolean; parts: Array<{ tenantId: string; regionName: string; brandName: string; record: { grants: unknown[] } | null }> }> };
    expect(screen.connections.map((c) => [c.id, c.regionName])).toEqual(
      expect.arrayContaining([
        ["ocn_aaaaaaaaaaaaaaaaaaaa", "Europe"],
        ["ocn_cccccccccccccccccccc", "United States"],
      ]),
    );
    const cf = screen.connections.find((c) => c.id === "ocn_aaaaaaaaaaaaaaaaaaaa")!;
    expect(cf).toMatchObject({ signer: null, mine: true });
    expect(cf.parts).toEqual([expect.objectContaining({ tenantId: US, brandName: "Fernhill US", regionName: "United States", record: expect.objectContaining({ grants: [{ to: "members", can: "read" }] }) })]);
    expect(JSON.stringify(screen)).not.toContain("made-up-org-token");
    expect(JSON.stringify(screen)).not.toContain("secrets");
  });
});
