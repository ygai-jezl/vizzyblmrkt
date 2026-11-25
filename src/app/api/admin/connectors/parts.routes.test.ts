import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { __resetRateLimitState } from "@/lib/tenant/rateLimit";

// The search databases: an in-memory index, since Stop using erases a part's searches.
vi.mock("@/lib/tenant/searchIndex", async () => {
  const { MemorySearchIndex } = await import("@/lib/search/memoryStore");
  const index = new MemorySearchIndex();
  return { searchStoreFor: (ctx: { tenantId: string }) => index.storeFor(ctx) };
});

// A brand's part through the connector routes (Connectors 3): Fernhill US [made up], kept in the
// United States, reads a Cloudflare zone through Fernhill Group's token, kept in Europe. Leo is
// Fernhill US's admin, Sam a member, and Otto the admin of a brand in another organisation. One fake
// database per region, with (default) the United States one. Nothing calls Cloudflare or Google.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const dbs = vi.hoisted(() => ({ map: {} as Record<string, unknown> }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: (id = "(default)") => dbs.map[id],
}));

const list = await import("./route");
const one = await import("./connections/[connectionId]/route");
const { createOrganisationConnection, forTenant, getOrganisationConnection, givePart } = await import("@/lib/tenant");
const { STOPPED_USING_MESSAGE } = await import("@/lib/connectors/service");
const { sealConnectorSecret } = await import("@/lib/connectors/vault");

const ORIGIN = "https://app.yougrow.test";
const ORG = "org_ten_fernhill";
const OCN = "ocn_aaaaaaaaaaaaaaaaaaaa";
const USE = "dcn_uuuuuuuuuuuuuuuuuuuu";
const EU = "ten_fernhill";
const US = "ten_fernhill-us";
const T0 = "2026-11-24T10:00:00.000Z";
const ZONE = "0123456789abcdef0123456789abcd01";

const leo = { tenantId: US, region: "us", source: "idtoken", userId: "usr_leo", role: "admin" };
const sam = { ...leo, userId: "usr_sam", role: "member" };
const otto = { tenantId: "ten_other", region: "us", source: "idtoken", userId: "usr_otto", role: "admin" };

let us: FakeFirestore;
let eu: FakeFirestore;
let fetchMock: ReturnType<typeof vi.fn>;
const regionDb = (r: string) => (r === "eu" ? eu : us);
const health = { state: "ok" as const, lastOkAt: T0, lastCheckedAt: T0, lastErrorCode: null, failures: 0, pausedUntil: null };

function req(method: string, path: string) {
  return new Request(`${ORIGIN}/api/admin/connectors${path}`, { method, headers: { "content-type": "application/json", host: "app.yougrow.test" } });
}
const p = (connectionId: string) => ({ params: Promise.resolve({ connectionId }) });

beforeEach(async () => {
  vi.clearAllMocks();
  __resetRateLimitState();
  us = new FakeFirestore();
  eu = new FakeFirestore();
  dbs.map = { "(default)": us, "signups-eu": eu, "signups-asia": new FakeFirestore() };
  fetchMock = vi.fn(async () => new Response("{}", { status: 500 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("CONNECTORS_ENABLED", "true");
  vi.stubEnv("CONNECTOR_CLOUDFLARE_ENABLED", "true");
  vi.stubEnv("CONNECTORS_VAULT_KEY", "parts-route-test-vault-root-0123456789a");
  vi.stubEnv("PLANS_ENABLED", "true");
  vi.stubEnv("CONNECTORS_SHARING_ENABLED", "true");
  vi.stubEnv("CONNECTORS_COLLECT_ENABLED", "true");
  const tenant = (id: string, name: string, region: string, organisationId: string) =>
    us.seed("tenants", id, { tenantName: name, rootDomain: `${id.replace("ten_", "")}.example`, ownerId: "usr_priya", status: "active", region, allowedOrigins: [], createdAt: T0, updatedAt: T0, organisationId });
  tenant(EU, "Fernhill Plants", "eu", ORG);
  tenant(US, "Fernhill US", "us", ORG);
  tenant("ten_other", "Other Shop", "us", "org_ten_other");
  us.seed("organisations", ORG, { name: "Fernhill Group", plan: "ultra", planSince: T0, brandIds: [EU, US], ownerIds: ["usr_priya"], createdBy: "usr_priya", createdAt: T0, updatedAt: T0 });
  const source = { organisationId: ORG, connectionId: OCN, region: "eu" as const };
  await createOrganisationConnection(
    {
      id: OCN,
      organisationId: ORG,
      region: "eu",
      connectorId: "cloudflare",
      method: "token_fields",
      label: "Cloudflare",
      createdBy: "usr_priya",
      signerUid: null,
      connectedFromTenantId: EU,
      secrets: { token: sealConnectorSecret(ORG, OCN, "token", "made-up-org-token", new Date(T0)) },
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
  const given = await givePart(
    {
      source,
      brand: { tenantId: US, region: "us" },
      record: {
        id: USE,
        connectorId: "cloudflare",
        method: "token_fields",
        label: "fernhill-us.example",
        account: ZONE,
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
  expect(given.ok).toBe(true);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const brandRecord = () => forTenant({ tenantId: US, region: "us", source: "system" }, us).dataConnections.getById(USE);
const orgRecord = async () => (await getOrganisationConnection(ORG, OCN, "eu", { regionDb: regionDb as never }))!;

describe("a part through the connector routes", () => {
  it("lists it for its brand From its organisation, naming both regions, and nothing of the sign in", async () => {
    session.getAdminContext.mockResolvedValue(leo);
    const res = await list.GET(req("GET", ""));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connections: Array<Record<string, unknown>> };
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0]).toMatchObject({ id: USE, part: { organisation: "Fernhill Group", brand: "Fernhill US", reads: "live", keptIn: "Europe", region: "United States" } });
    expect(JSON.stringify(body)).not.toContain(OCN);
    expect(JSON.stringify(body)).not.toContain("made-up-org-token");
  });

  it("Stop using, by the brand's admin: ends the part in both regions and says the owners see it, with no call to any provider", async () => {
    session.getAdminContext.mockResolvedValue(leo);
    const res = await one.DELETE(req("DELETE", `/connections/${USE}`), p(USE));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: string; revoked: boolean; addressDeleted: unknown; connection: { status: string; part: { reads: string; ended: { why: string } } } };
    expect(body).toMatchObject({ message: STOPPED_USING_MESSAGE, revoked: false, addressDeleted: null });
    expect(body.connection).toMatchObject({ status: "disconnected", part: { reads: "ended", ended: { why: "stopped_using" } } });
    // The brand record, in the United States: disconnected, with what it collected marked for erasing.
    expect(await brandRecord()).toMatchObject({ status: "disconnected", secrets: {} });
    // The organisation's record, in Europe: the part has gone, and its token stays for other brands.
    const org = await orgRecord();
    expect(org.parts).toEqual([]);
    expect(org.status).toBe("connected");
    expect(Object.keys(org.secrets)).toEqual(["token"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is refused to a member, and is not found for another brand", async () => {
    session.getAdminContext.mockResolvedValue(sam);
    expect((await one.DELETE(req("DELETE", `/connections/${USE}`), p(USE))).status).toBe(403);
    session.getAdminContext.mockResolvedValue(otto);
    expect((await one.DELETE(req("DELETE", `/connections/${USE}`), p(USE))).status).toBe(404);
    expect((await brandRecord())?.status).toBe("connected");
    expect((await orgRecord()).parts).toHaveLength(1);
  });

  it("refuses a cross site Stop using before the session is read", async () => {
    session.getAdminContext.mockResolvedValue(leo);
    const cross = new Request(`${ORIGIN}/api/admin/connectors/connections/${USE}`, { method: "DELETE", headers: { host: "app.yougrow.test", origin: "https://other.example" } });
    expect((await one.DELETE(cross, p(USE))).status).toBe(403);
    expect((await brandRecord())?.status).toBe("connected");
  });
});
