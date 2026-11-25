import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { timestampFirestore } from "@/lib/tenant/testing/timestampFirestore";

// The search databases: an in-memory index, since ending a part erases its searches.
vi.mock("@/lib/tenant/searchIndex", async () => {
  const { MemorySearchIndex } = await import("@/lib/search/memoryStore");
  const index = new MemorySearchIndex();
  return { searchStoreFor: (ctx: { tenantId: string }) => index.storeFor(ctx) };
});

// The organisation brands routes (Connectors 3 group 4, ORGANISATION_JOIN_ENABLED): the Brands
// section and Bring in. Fernhill Group [made up] has Fernhill Plants (Europe), Priya's home brand
// (claims, no tenant_users row), and Fernhill US (United States, an admin row). Priya also owns
// Fernhill Cafe's own organisation and has an admin row there. Leo is an admin of Fernhill Plants
// who isn't an owner; Sam is a member. One fake database per region, with (default) the United
// States one, keeping dates as Firestore does.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn(), getAdminContextWithHome: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const dbs = vi.hoisted(() => ({ map: {} as Record<string, unknown> }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: (id = "(default)") => dbs.map[id],
}));

const brands = await import("./route");
const { createOrganisationConnection, forTenant, getOrganisationConnection, givePart } = await import("@/lib/tenant");

const ORIGIN = "https://app.yougrow.test";
const ORG = "org_ten_fernhill";
const EU = "ten_fernhill";
const US = "ten_fernhill-us";
const CAFE = "ten_cafe";
const T0 = "2026-11-24T10:00:00.000Z";
const OCN_CAFE = "ocn_cccccccccccccccccccc";
const USE_CAFE = "dcn_cccccccccccccccccccc";

const priya = { tenantId: EU, region: "eu", source: "idtoken", userId: "usr_priya", role: "admin" };
const leo = { tenantId: EU, region: "eu", source: "idtoken", userId: "usr_leo", role: "admin" };
const sam = { tenantId: EU, region: "eu", source: "idtoken", userId: "usr_sam", role: "member" };
const as = (ctx: Record<string, unknown>, home = EU, homeRole: "admin" | "member" = "admin") => session.getAdminContextWithHome.mockResolvedValue({ ctx, homeTenantId: home, homeRole });

let us: FakeFirestore;
let eu: FakeFirestore;
let asia: FakeFirestore;
const regionDb = (r: string) => (r === "eu" ? eu : r === "asia" ? asia : us);

function req(method: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/api/admin/organisation/brands`, {
    method,
    headers: { "content-type": "application/json", host: "app.yougrow.test", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function seed() {
  const tenant = (id: string, name: string, region: string, organisationId: string, orgPlan: string) =>
    us.seed("tenants", id, { tenantName: name, rootDomain: `${id.replace("ten_", "")}.example`, ownerId: "usr_priya", status: "active", region, allowedOrigins: [], createdAt: T0, updatedAt: T0, organisationId, orgPlan });
  const org = (id: string, name: string, plan: string, brandIds: string[], ownerIds: string[]) =>
    us.seed("organisations", id, { name, plan, planSince: T0, brandIds, ownerIds, createdBy: "usr_priya", createdAt: T0, updatedAt: T0 });
  tenant(EU, "Fernhill Plants", "eu", ORG, "ultra");
  tenant(US, "Fernhill US", "us", ORG, "ultra");
  tenant(CAFE, "Fernhill Cafe", "eu", "org_ten_cafe", "free");
  org(ORG, "Fernhill Group", "ultra", [EU, US], ["usr_priya"]);
  org("org_ten_cafe", "Fernhill Cafe", "free", [CAFE], ["usr_priya"]);
  us.seed("tenant_users", "usr_priya_ten_fernhill-us", { userId: "usr_priya", tenantId: US, role: "admin", joinedAt: T0 });
  us.seed("tenant_users", "usr_priya_ten_cafe", { userId: "usr_priya", tenantId: CAFE, role: "admin", joinedAt: T0 });
  us.seed("tenant_users", "usr_leo_ten_fernhill", { userId: "usr_leo", tenantId: EU, role: "admin", joinedAt: T0 });
}

const health = { state: "ok" as const, lastOkAt: T0, lastCheckedAt: T0, lastErrorCode: null, failures: 0, pausedUntil: null };

/** Fernhill Cafe's own organisation holds a Cloudflare token kept in Europe, with one zone given to Fernhill Cafe. */
async function seedCafePart() {
  const source = { organisationId: "org_ten_cafe", connectionId: OCN_CAFE, region: "eu" as const };
  await createOrganisationConnection(
    {
      id: OCN_CAFE,
      organisationId: "org_ten_cafe",
      region: "eu",
      connectorId: "cloudflare",
      method: "token_fields",
      label: "Cloudflare",
      createdBy: "usr_priya",
      signerUid: null,
      connectedFromTenantId: CAFE,
      secrets: {},
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
  const r = await givePart(
    {
      source,
      brand: { tenantId: CAFE, region: "eu" },
      record: {
        id: USE_CAFE,
        connectorId: "cloudflare",
        method: "token_fields",
        label: "fernhillcafe.example",
        account: "0123456789abcdef0123456789abcd09",
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
  if (!r.ok) throw new Error(r.why);
}

beforeEach(() => {
  vi.clearAllMocks();
  us = timestampFirestore(new FakeFirestore());
  eu = timestampFirestore(new FakeFirestore());
  asia = timestampFirestore(new FakeFirestore());
  dbs.map = { "(default)": us, "signups-eu": eu, "signups-asia": asia };
  seed();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("PLANS_ENABLED", "true");
  vi.stubEnv("ORGANISATION_JOIN_ENABLED", "true");
  // Sharing stays off: the join works without it, and still ends parts.
  vi.stubEnv("CONNECTORS_SHARING_ENABLED", "false");
  as(priya);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the organisation brands routes: who gets in", () => {
  it("answer 404 with the join or plans off, before reading the session", async () => {
    for (const off of ["ORGANISATION_JOIN_ENABLED", "PLANS_ENABLED"]) {
      vi.stubEnv(off, "false");
      expect((await brands.GET(req("GET"))).status).toBe(404);
      expect((await brands.POST(req("POST", { tenantId: CAFE }))).status).toBe(404);
      vi.stubEnv(off, "true");
    }
    expect(session.getAdminContextWithHome).not.toHaveBeenCalled();
  });

  it("refuse another site's request, a member, and an admin who isn't an owner", async () => {
    expect((await brands.POST(req("POST", { tenantId: CAFE }, { origin: "https://elsewhere.example" }))).status).toBe(403);
    as(sam, EU, "member");
    expect((await brands.GET(req("GET"))).status).toBe(403);
    as(leo, "ten_leo");
    const r = await brands.POST(req("POST", { tenantId: CAFE }));
    expect(r.status).toBe(403);
    expect(us.raw("tenants", CAFE)).toMatchObject({ organisationId: "org_ten_cafe" });
  });

  it("take no organisation from the body: only the brand", async () => {
    expect((await brands.POST(req("POST", { tenantId: CAFE, organisationId: "org_ten_cafe" }))).status).toBe(400);
    expect((await brands.POST(req("POST", {}))).status).toBe(400);
  });
});

describe("the Brands section", () => {
  it("lists the brands in every region and the brands Priya could bring in, with sharing off", async () => {
    const res = await brands.GET(req("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.brands.map((b: { name: string; regionName: string; moveRefusal: string | null }) => [b.name, b.regionName, b.moveRefusal])).toEqual([
      ["Fernhill Plants", "Europe", "home_only"],
      ["Fernhill US", "United States", null],
    ]);
    expect(body.candidates.map((c: { name: string }) => c.name)).toEqual(["Fernhill Cafe"]);
  });
});

describe("Bring in", () => {
  it("brings Fernhill Cafe in, ends its part from its own organisation whatever sharing says, and disconnects that organisation's connection", async () => {
    await seedCafePart();
    const res = await brands.POST(req("POST", { tenantId: CAFE }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: "Fernhill Cafe joined Fernhill Group.", ended: 1, disconnected: 1 });
    expect(us.raw("tenants", CAFE)).toMatchObject({ organisationId: ORG, orgPlan: "ultra" });
    expect(await forTenant({ tenantId: CAFE, region: "eu", source: "system" }, eu).dataConnections.getById(USE_CAFE)).toMatchObject({ status: "disconnected" });
    expect((await getOrganisationConnection("org_ten_cafe", OCN_CAFE, "eu", { regionDb: regionDb as never }))?.status).toBe("disconnected");
    // Nothing of Fernhill Cafe's was written in another region.
    expect(us.dump("data_connections")).toEqual([]);
  });

  it("refuses a brand Priya reaches only by her home brand's claims", async () => {
    as({ ...priya, tenantId: US, region: "us" }, "ten_home");
    us.seed("tenants", "ten_home", { tenantName: "Home Shop", rootDomain: "home.example", ownerId: "usr_priya", status: "active", region: "eu", allowedOrigins: [], createdAt: T0, updatedAt: T0, organisationId: "org_ten_home", orgPlan: "ultra" });
    us.seed("organisations", "org_ten_home", { name: "Home Shop", plan: "ultra", planSince: T0, brandIds: ["ten_home"], ownerIds: ["usr_priya"], createdBy: "usr_priya", createdAt: T0, updatedAt: T0 });
    const res = await brands.POST(req("POST", { tenantId: "ten_home" }));
    expect(res.status).toBe(403);
    expect((await res.json()).message).toBe(
      "You can't bring Home Shop in here. Moves need you on Home Shop's team as an admin, and you reach Home Shop as the brand you first signed in with. Ask whoever runs YouGrow to add you to its team, or to move it for you.",
    );
    expect(us.raw("tenants", "ten_home")).toMatchObject({ organisationId: "org_ten_home" });
  });
});
