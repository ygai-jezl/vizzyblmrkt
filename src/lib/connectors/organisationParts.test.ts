import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOrganisationConnection, endPart, forTenant, getOrganisationConnection, type SourceRef, type TenantContext } from "@/lib/tenant";
import { organisationBrands, sharedConnectionView } from "./organisationConnect";
import type { DataConnection } from "@/lib/types/dataConnection";
import { organisationOwnerOf, type OrganisationOwner } from "./organisationOwner";
import { changePartOf, givePartTo, listOrganisationAccounts, takeBackPart } from "./organisationParts";
import { sealConnectorSecret } from "./vault";
import { EU_BRAND, OCN, ORG, orgWorld, seedFernhill, seedSource, seedTenant, T0, US_BRAND, type OrgWorld } from "./testing/organisation";

vi.mock("@/lib/tenant/searchIndex", async () => {
  const { MemorySearchIndex } = await import("@/lib/search/memoryStore");
  const index = new MemorySearchIndex();
  return { searchStoreFor: (ctx: { tenantId: string }) => index.storeFor(ctx) };
});

// Giving, changing and taking back a brand's part (Connectors 3). Fernhill Group [made up] keeps a
// Cloudflare token in Europe (connected from Fernhill Plants); Fernhill US is kept in the United
// States. Priya owns the group: Fernhill Plants is her home brand (claims, no tenant_users row), and
// she has an admin row on Fernhill US. Cloudflare is a stub that knows three zones.
const ZONE_EU = "0123456789abcdef0123456789abcd01";
const ZONE_US = "0123456789abcdef0123456789abcd02";
const ZONE_OLD = "0123456789abcdef0123456789abcd03";
const NOW = new Date("2026-11-24T12:00:00.000Z");
const priyaCtx: TenantContext = { ...EU_BRAND, source: "idtoken", userId: "usr_priya", role: "admin" };
const person = { userId: "usr_priya", homeTenantId: EU_BRAND.tenantId, homeRole: "admin" as const };

let w: OrgWorld;
let source: SourceRef;
let owner: OrganisationOwner;
let transport: ReturnType<typeof vi.fn>;
let readable: Set<string>;
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const deps = () => ({ db: w.eu, controlDb: w.us, regionDb: w.regionDb, transport, limit: async () => false, log: () => {}, now: NOW, newId: undefined as (() => string) | undefined });
const orgRecord = async (id = OCN, region: "eu" | "us" = "eu") => (await getOrganisationConnection(ORG, id, region, { regionDb: w.regionDb }))!;
const brandRecords = (db: OrgWorld["us"]) => db.dump("data_connections") as Array<Record<string, unknown>>;
const give = (tenantId: string, account: string, extra: Record<string, unknown> = {}) => givePartTo(owner, OCN, { tenantId, account, members: true, vizzy: false, ...extra }, deps());

async function ownerOf(ctx: TenantContext, p = person): Promise<OrganisationOwner> {
  const r = await organisationOwnerOf(ctx, p, { controlDb: w.us });
  if (!r.ok) throw new Error(r.why);
  return r.owner;
}

beforeEach(async () => {
  vi.stubEnv("CONNECTORS_VAULT_KEY", "org-parts-test-vault-root-0123456789abc");
  vi.stubEnv("CONNECTORS_ENABLED", "true");
  vi.stubEnv("CONNECTOR_CLOUDFLARE_ENABLED", "true");
  vi.stubEnv("PLANS_ENABLED", "true");
  vi.stubEnv("CONNECTORS_SHARING_ENABLED", "true");
  vi.stubEnv("CONNECTORS_COLLECT_ENABLED", "true");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  readable = new Set([ZONE_EU, ZONE_US, ZONE_OLD]);
  transport = vi.fn(async (url: string, init: RequestInit) => {
    if (url.startsWith("https://api.cloudflare.com/client/v4/zones")) {
      return answer({ success: true, result: [...readable].map((id, i) => ({ id, name: ["fernhill.example", "fernhill-us.example", "old.example"][i], status: "active" })), result_info: { total_pages: 1 } });
    }
    const zone = (JSON.parse(String(init.body)) as { variables: { zoneTag: string } }).variables.zoneTag;
    return readable.has(zone) ? answer({ data: { viewer: { zones: [{ httpRequests1dGroups: [] }] } }, errors: null }) : answer({ data: null, errors: [{ message: `zones [${zone}] are not authorized` }] });
  });
  w = orgWorld();
  seedFernhill(w);
  w.us.seed("tenant_users", "priya-us", { userId: "usr_priya", tenantId: US_BRAND.tenantId, role: "admin", joinedAt: T0 });
  source = await seedSource(w, { secrets: { token: sealConnectorSecret(ORG, OCN, "token", "made-up-org-token", new Date(T0)) } });
  owner = await ownerOf(priyaCtx);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("giving a brand a part", () => {
  it("gives a United States brand a zone of a token kept in Europe: its record only in the United States, the part only in Europe", async () => {
    const r = await give(US_BRAND.tenantId, ZONE_US, { label: "fernhill-us.example" });
    expect(r).toMatchObject({ ok: true, status: 201, value: { active: true } });
    const id = r.ok ? r.value.connectionId : "";
    expect(brandRecords(w.us)).toHaveLength(1);
    expect(brandRecords(w.eu)).toHaveLength(0);
    const rec = (await forTenant({ ...US_BRAND, source: "system" }, w.us).dataConnections.getById(id)) as DataConnection;
    expect(rec).toMatchObject({ account: ZONE_US, label: "fernhill-us.example", source, secrets: {}, grants: [{ to: "members", can: "read" }], method: "token_fields" });
    expect(rec.serviceAccount ?? null).toBeNull();
    expect((await orgRecord()).parts).toEqual([expect.objectContaining({ tenantId: US_BRAND.tenantId, region: "us", account: ZONE_US, useId: id, state: "active", givenBy: "usr_priya" })]);
    // Nothing of the brand's reaches the European database beyond the part entry.
    expect(Object.keys(w.eu.dump("data_connection_activity"))).toHaveLength(0);
  });

  it("gives the owner's home brand a part by its claims, with no tenant_users row", async () => {
    expect(await give(EU_BRAND.tenantId, ZONE_EU)).toMatchObject({ ok: true });
  });

  it("refuses a brand where the owner isn't an admin, read live, and one outside the organisation", async () => {
    w.us.seed("tenant_users", "priya-us", { userId: "usr_priya", tenantId: US_BRAND.tenantId, role: "member", joinedAt: T0 });
    expect(await give(US_BRAND.tenantId, ZONE_US)).toMatchObject({ ok: false, status: 403, error: "not_brand_admin", message: "You're not an admin of Fernhill US, so you can't give it a part. Ask one of its admins to add you to its team." });
    seedTenant(w, { tenantId: "ten_stranger", region: "us" }, "org_ten_stranger");
    w.us.seed("tenant_users", "priya-stranger", { userId: "usr_priya", tenantId: "ten_stranger", role: "admin", joinedAt: T0 });
    expect(await give("ten_stranger", ZONE_US)).toMatchObject({ ok: false, status: 404, error: "not_in_organisation" });
    // Listed by the organisation but pointing elsewhere is drift: refused too.
    seedTenant(w, US_BRAND, "org_ten_elsewhere");
    w.us.seed("tenant_users", "priya-us", { userId: "usr_priya", tenantId: US_BRAND.tenantId, role: "admin", joinedAt: T0 });
    expect(await give(US_BRAND.tenantId, ZONE_US)).toMatchObject({ ok: false, status: 404 });
    expect(brandRecords(w.us)).toHaveLength(0);
    expect((await orgRecord()).parts).toEqual([]);
  });

  it("takes no organisation, region or brand region from the request", async () => {
    expect(await give(US_BRAND.tenantId, ZONE_US, { region: "asia" })).toMatchObject({ ok: false, status: 400, error: "invalid_input" });
    expect(await give(US_BRAND.tenantId, ZONE_US, { organisationId: "org_ten_other" })).toMatchObject({ ok: false, status: 400 });
    expect(Object.keys(w.asia.dump("data_connections"))).toHaveLength(0);
  });

  it("gives each brand one part, and each part once, also when two owners press Give together", async () => {
    expect(await give(US_BRAND.tenantId, ZONE_US)).toMatchObject({ ok: true });
    expect(await give(US_BRAND.tenantId, ZONE_OLD)).toMatchObject({ ok: false, status: 409, error: "has_part" });
    expect(await give(EU_BRAND.tenantId, ZONE_US)).toMatchObject({ ok: false, status: 409, error: "part_given" });
    const both = await Promise.all([give(EU_BRAND.tenantId, ZONE_EU), give(EU_BRAND.tenantId, ZONE_EU)]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect((await orgRecord()).parts.map((p) => p.account).sort()).toEqual([ZONE_EU, ZONE_US].sort());
  });

  it("refuses a part given through another of the organisation's connections, kept in another region", async () => {
    const second = "ocn_bbbbbbbbbbbbbbbbbbbb";
    await createOrganisationConnection(
      {
        ...(await orgRecord()),
        id: second,
        region: "us",
        connectedFromTenantId: US_BRAND.tenantId,
        secrets: { token: sealConnectorSecret(ORG, second, "token", "made-up-second-token", new Date(T0)) },
        parts: [{ tenantId: EU_BRAND.tenantId, region: "eu", account: ZONE_US, useId: "dcn_xxxxxxxxxxxxxxxxxxxx", state: "active", stateSince: T0, was: null, givenBy: "usr_priya", givenAt: T0, endedBy: null }],
      },
      [],
      { regionDb: w.regionDb },
    );
    expect(await give(US_BRAND.tenantId, ZONE_US)).toMatchObject({ ok: false, status: 409, error: "part_given" });
  });

  it("refuses a part the brand reads with its own connection, undoing the first step", async () => {
    w.us.seed("data_connections", "dcn_ownownownownownownown", {
      tenantId: US_BRAND.tenantId,
      connectorId: "cloudflare",
      method: "token_fields",
      label: "Cloudflare",
      account: ZONE_US,
      ownerUid: "usr_leo",
      grants: [],
      secrets: {},
      health: { state: "ok", lastOkAt: T0, lastCheckedAt: T0, lastErrorCode: null, failures: 0, pausedUntil: null },
      pausedAt: null,
      pausedBy: null,
      status: "connected",
      createdAt: T0,
      updatedAt: T0,
      disconnectedAt: null,
      recent: [],
    });
    const r = await give(US_BRAND.tenantId, ZONE_US);
    expect(r).toMatchObject({ ok: false, status: 409, error: "own_connection", message: "Fernhill US already has its own Cloudflare connection to this zone. Disconnect that one first." });
    expect((await orgRecord()).parts).toEqual([]);
  });

  it("refuses a part the token can't read now, writing nothing", async () => {
    readable.delete(ZONE_US);
    expect(await give(US_BRAND.tenantId, ZONE_US)).toMatchObject({ ok: false, status: 400, error: "account_refused" });
    expect((await orgRecord()).parts).toEqual([]);
    expect(brandRecords(w.us)).toHaveLength(0);
    // One part refused is not the token's failure: the organisation's record stays healthy.
    expect((await orgRecord()).health.state).toBe("ok");
  });
});

describe("what owners see after a brand stops using a part", () => {
  it("says who stopped using it until that brand is given a part again", async () => {
    const stopped = async () => (await sharedConnectionView(owner, await orgRecord(), await organisationBrands(owner, deps()), deps())).stoppedUsing;
    await give(US_BRAND.tenantId, ZONE_US);
    const useId = (await orgRecord()).parts[0]!.useId;
    await endPart({ source, brand: US_BRAND, useId, by: "usr_leo", at: NOW.toISOString(), code: "stopped_using" }, { regionDb: w.regionDb });
    expect(await stopped()).toMatchObject({ brandName: "Fernhill US" });
    await give(US_BRAND.tenantId, ZONE_OLD);
    expect(await stopped()).toBeNull();
  });
});

describe("the list a dialog shows", () => {
  it("counts a brand the owner doesn't run that reads a part with its own connection, and never sends its id", async () => {
    // Priya is no longer on Fernhill US's team; Fernhill US reads the old zone with its own connection.
    w.us.seed("tenant_users", "priya-us", { userId: "usr_priya", tenantId: US_BRAND.tenantId, role: "member", joinedAt: T0 });
    w.us.seed("data_connections", "dcn_ownownownownownownown", {
      tenantId: US_BRAND.tenantId,
      connectorId: "cloudflare",
      method: "token_fields",
      label: "Cloudflare",
      account: ZONE_OLD,
      ownerUid: "usr_leo",
      grants: [],
      secrets: {},
      health: { state: "ok", lastOkAt: T0, lastCheckedAt: T0, lastErrorCode: null, failures: 0, pausedUntil: null },
      pausedAt: null,
      pausedBy: null,
      status: "connected",
      createdAt: T0,
      updatedAt: T0,
      disconnectedAt: null,
      recent: [],
    });
    const r = await listOrganisationAccounts(await ownerOf(priyaCtx), OCN, deps());
    expect(r.ok).toBe(true);
    const old = (r.ok ? r.value.accounts : []).find((a) => a.id === ZONE_OLD)!;
    expect(old).toMatchObject({ ownCount: 1, ownAdminBrandIds: [] });
    expect(JSON.stringify(r.ok ? r.value : null)).not.toContain(US_BRAND.tenantId);
  });

  it("marks what is given here or elsewhere and which brands read it with their own connection", async () => {
    await give(US_BRAND.tenantId, ZONE_US);
    w.eu.seed("data_connections", "dcn_ownownownownownownown", {
      tenantId: EU_BRAND.tenantId,
      connectorId: "cloudflare",
      method: "token_fields",
      label: "Cloudflare",
      account: ZONE_OLD,
      ownerUid: "usr_leo",
      grants: [],
      secrets: {},
      health: { state: "ok", lastOkAt: T0, lastCheckedAt: T0, lastErrorCode: null, failures: 0, pausedUntil: null },
      pausedAt: null,
      pausedBy: null,
      status: "connected",
      createdAt: T0,
      updatedAt: T0,
      disconnectedAt: null,
      recent: [],
    });
    const r = await listOrganisationAccounts(owner, OCN, deps());
    expect(r.ok).toBe(true);
    const byId = new Map((r.ok ? r.value.accounts : []).map((a) => [a.id, a]));
    expect(byId.get(ZONE_US)).toMatchObject({ givenTo: { tenantId: US_BRAND.tenantId }, givenElsewhere: null, ownCount: 0, ownAdminBrandIds: [] });
    expect(byId.get(ZONE_OLD)).toMatchObject({ givenTo: null, ownCount: 1, ownAdminBrandIds: [EU_BRAND.tenantId] });
    expect(byId.get(ZONE_EU)).toMatchObject({ givenTo: null, givenElsewhere: null, ownCount: 0, ownAdminBrandIds: [] });
  });

  it("for a Google sign in, shows its list and lets it give only to the owner who signed in", async () => {
    vi.stubEnv("CONNECTOR_SEARCH_CONSOLE_ENABLED", "true");
    vi.stubEnv("CONNECTOR_GOOGLE_CLIENT_ID", "made-up-client.example.test");
    vi.stubEnv("CONNECTOR_GOOGLE_CLIENT_SECRET", "made-up-client-secret");
    const signedIn = "ocn_gggggggggggggggggggg";
    await createOrganisationConnection(
      { ...(await orgRecord()), id: signedIn, connectorId: "search-console", method: "oauth_pkce", signerUid: "usr_alex", secrets: {} },
      [],
      { regionDb: w.regionDb },
    );
    expect(await listOrganisationAccounts(owner, signedIn, deps())).toMatchObject({ ok: false, status: 403, error: "signer_only" });
    expect(await givePartTo(owner, signedIn, { tenantId: US_BRAND.tenantId, account: "sc-domain:fernhill-us.example", members: true, vizzy: true }, deps())).toMatchObject({ ok: false, status: 403, error: "signer_only" });
  });
});

describe("changing and taking back a part", () => {
  it("changes a brand's zone: the old numbers' generation is marked and erased, the new one starts, the part reads the new zone", async () => {
    const given = await give(US_BRAND.tenantId, ZONE_US);
    const id = given.ok ? given.value.connectionId : "";
    const before = (await forTenant({ ...US_BRAND, source: "system" }, w.us).dataConnections.getById(id))!;
    const r = await changePartOf(owner, OCN, { tenantId: US_BRAND.tenantId, account: ZONE_OLD, label: "old.example" }, deps());
    expect(r).toMatchObject({ ok: true, value: { connectionId: id, active: true } });
    const after = (await forTenant({ ...US_BRAND, source: "system" }, w.us).dataConnections.getById(id))!;
    expect(after).toMatchObject({ account: ZONE_OLD, label: "old.example", status: "connected" });
    expect(after.collect!.gen).toBe(before.collect!.gen + 1);
    expect(after.collect!.leaseId).toBeNull();
    expect((await orgRecord()).parts).toEqual([expect.objectContaining({ tenantId: US_BRAND.tenantId, account: ZONE_OLD, state: "active", was: null })]);
  });

  it("refuses a change to a part given to another brand", async () => {
    await give(US_BRAND.tenantId, ZONE_US);
    await give(EU_BRAND.tenantId, ZONE_EU);
    expect(await changePartOf(owner, OCN, { tenantId: US_BRAND.tenantId, account: ZONE_EU }, deps())).toMatchObject({ ok: false, status: 409, error: "part_given" });
  });

  it("takes a part back: the brand record ends in its region and the entry leaves the organisation's record", async () => {
    const given = await give(US_BRAND.tenantId, ZONE_US);
    const id = given.ok ? given.value.connectionId : "";
    const r = await takeBackPart(owner, OCN, { tenantId: US_BRAND.tenantId }, deps());
    expect(r).toMatchObject({ ok: true, value: { ended: true, message: null } });
    // Ended, and what it collected erased at once (nothing is left pending).
    expect(await forTenant({ ...US_BRAND, source: "system" }, w.us).dataConnections.getById(id)).toMatchObject({ status: "disconnected", secrets: {}, collect: expect.objectContaining({ erasePending: null }) });
    expect((await orgRecord()).parts).toEqual([]);
    expect(await takeBackPart(owner, OCN, { tenantId: US_BRAND.tenantId }, deps())).toMatchObject({ ok: false, status: 404, error: "no_part" });
  });

  it("refuses another organisation's connection, wherever it is kept", async () => {
    const theirs = "ocn_tttttttttttttttttttt";
    await createOrganisationConnection({ ...(await orgRecord()), id: theirs, organisationId: "org_ten_other", region: "us" }, [], { regionDb: w.regionDb });
    expect(await givePartTo(owner, theirs, { tenantId: EU_BRAND.tenantId, account: ZONE_EU, members: true, vizzy: true }, deps())).toMatchObject({ ok: false, status: 404 });
    expect(await listOrganisationAccounts(owner, theirs, deps())).toMatchObject({ ok: false, status: 404 });
    expect(await takeBackPart(owner, theirs, { tenantId: EU_BRAND.tenantId }, deps())).toMatchObject({ ok: false, status: 404 });
  });
});
