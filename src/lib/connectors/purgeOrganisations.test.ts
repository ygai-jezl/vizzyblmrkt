import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forTenant, getOrganisationConnection, type SourceRef } from "@/lib/tenant";
import type { DataConnection } from "@/lib/types/dataConnection";
import { organisationPurgeLines, purgeConnections, purgeOrganisations } from "./purge";
import { resealOrganisationRegion } from "./reseal";
import { copyTag, organisationShareDescription, shareDescription } from "./shareAccess";
import { openConnectorSecret, sealConnectorSecret } from "./vault";
import { EU_BRAND, OCN, ORG, OTHER_ORG, orgWorld, seedFernhill, seedOrganisation, seedPart, seedSource, T0, US_BRAND, USE_EU, USE_US, type OrgWorld } from "./testing/organisation";

vi.mock("@/lib/tenant/searchIndex", async () => {
  const { MemorySearchIndex } = await import("@/lib/search/memoryStore");
  const index = new MemorySearchIndex();
  return { searchStoreFor: (ctx: { tenantId: string }) => index.storeFor(ctx) };
});

// The organisation purge and reseal (Connectors 3), with every connector switch off: they run
// whatever any switch says, in every region. A fake IAM keeps the identities project's addresses.
const PROJECT = "made-up-identities";
const ZONE_US = "0123456789abcdef0123456789abcd01";
const ZONE_EU = "0123456789abcdef0123456789abcd02";
const NOW = new Date("2026-11-24T12:00:00.000Z");
const US_SITE_OCN = "ocn_uuuuuuuuuuuuuuuuuuuu";
const THEIRS = "ocn_tttttttttttttttttttt";

let w: OrgWorld;
let source: SourceRef;
let accounts: Map<string, { email: string; uniqueId: string; description: string }>;
let transport: ReturnType<typeof vi.fn>;
const address = (n: string) => `ygc-${n.repeat(20)}@${PROJECT}.iam.gserviceaccount.com`;
const addAccount = (uniqueId: string, n: string, description: string) => accounts.set(uniqueId, { email: address(n), uniqueId, description });
const opts = (apply: boolean) => ({ apply, by: "ops", now: NOW, regionDb: w.regionDb, controlDb: w.us, transport, appToken: async () => "made-up-app-token", log: () => {} });

beforeEach(async () => {
  for (const name of ["CONNECTORS_ENABLED", "CONNECTORS_SHARING_ENABLED", "PLANS_ENABLED", "CONNECTOR_GOOGLE_REVOKE_ENABLED"]) vi.stubEnv(name, "");
  vi.stubEnv("CONNECTORS_VAULT_KEY", "purge-orgs-vault-root-0123456789abcdef01");
  vi.stubEnv("CONNECTORS_IDENTITIES_PROJECT", PROJECT);
  vi.stubEnv("GOOGLE_CLOUD_PROJECT", "made-up-copy");
  accounts = new Map();
  transport = vi.fn(async (url: string, init: RequestInit) => {
    const u = new URL(url);
    if (init.method === "DELETE") {
      accounts.delete(u.pathname.split("/").pop()!);
      return new Response("{}", { status: 200 });
    }
    return new Response(JSON.stringify({ accounts: [...accounts.values()] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  w = orgWorld();
  seedFernhill(w);
  // Fernhill Group: a token kept in Europe, and a Google address kept in the United States.
  source = await seedSource(w, { secrets: { token: sealConnectorSecret(ORG, OCN, "token", "made-up-org-token", new Date(T0)) } });
  await seedPart(w, source, US_BRAND, { useId: USE_US, account: ZONE_US });
  await seedPart(w, source, EU_BRAND, { useId: USE_EU, account: ZONE_EU });
  await seedSource(w, {
    id: US_SITE_OCN,
    region: "us",
    connectorId: "search-console",
    method: "share_access",
    label: "Search Console",
    connectedFromTenantId: US_BRAND.tenantId,
    serviceAccount: { email: address("a"), uniqueId: "1001", createdAt: T0, deletedAt: null },
  });
  addAccount("1001", "a", organisationShareDescription(ORG, US_SITE_OCN));
  // Other Co's own address, live, in Europe.
  seedOrganisation(w, OTHER_ORG, ["ten_other"], ["usr_other"], "Other Co");
  await seedSource(w, { id: THEIRS, organisationId: OTHER_ORG, connectedFromTenantId: "ten_other", connectorId: "search-console", method: "share_access", label: "Search Console", serviceAccount: { email: address("b"), uniqueId: "2002", createdAt: T0, deletedAt: null } });
  addAccount("2002", "b", organisationShareDescription(OTHER_ORG, THEIRS));
  // A leftover of Fernhill's that no record owns, and one of another copy.
  addAccount("3003", "c", organisationShareDescription(ORG, "ocn_llllllllllllllllllll"));
  addAccount("4004", "d", organisationShareDescription(ORG, "ocn_cccccccccccccccccccc", "0000000000000000"));
});
afterEach(() => vi.unstubAllEnvs());

describe("the organisation purge", () => {
  it("counts every region's connections of one organisation in a dry run, and writes nothing", async () => {
    const r = await purgeOrganisations(ORG, opts(false));
    expect(r.items.map((i) => [i.connectionId, i.region, i.parts, i.address])).toEqual([
      [OCN, "eu", 2, "none"],
      [US_SITE_OCN, "us", 0, "kept"],
    ]);
    expect(r.orphans.map((o) => o.email)).toEqual([address("c")]);
    expect((await getOrganisationConnection(ORG, OCN, "eu", { regionDb: w.regionDb }))!.status).toBe("connected");
    expect(organisationPurgeLines(r).join("\n")).not.toContain("made-up-org-token");
  });

  it("with apply, ends every part in each brand's region, deletes this organisation's addresses only, then says nothing is left", async () => {
    const r = await purgeOrganisations(ORG, opts(true));
    expect(r.removed.map((x) => [x.connectionId, x.ended, x.addressDeleted])).toEqual([
      [OCN, 2, null],
      [US_SITE_OCN, 0, true],
    ]);
    for (const [brand, id] of [[US_BRAND, USE_US], [EU_BRAND, USE_EU]] as const) {
      expect(((await forTenant({ ...brand, source: "system" }, w.regionDb(brand.region)).dataConnections.getById(id)) as DataConnection).status).toBe("disconnected");
    }
    expect([...accounts.keys()].sort()).toEqual(["2002", "4004"]);
    expect(w.eu.dump("organisation_connection_activity").filter((a) => a.connectionId === OCN).map((a) => a.kind)).toEqual(["purged"]);
    const again = await purgeOrganisations(ORG, opts(false));
    expect(again.items.every((i) => i.status === "disconnected" && i.secrets === 0 && i.parts === 0 && i.address !== "kept")).toBe(true);
    expect(again.orphans).toEqual([]);
    // Other Co's connection is untouched.
    expect((await getOrganisationConnection(OTHER_ORG, THEIRS, "eu", { regionDb: w.regionDb }))!.status).toBe("connected");
  });

  it("covers every organisation with all, and refuses anything but an organisation id", async () => {
    expect((await purgeOrganisations("all", opts(false))).items.map((i) => i.connectionId).sort()).toEqual([OCN, THEIRS, US_SITE_OCN].sort());
    await expect(purgeOrganisations("ten_fernhill", opts(false))).rejects.toThrow();
  });
});

describe("a brand's purge and shared connections", () => {
  it("never takes an organisation's address for its own leftover, and ends its part on the organisation's record in Europe", async () => {
    addAccount("5005", "e", shareDescription(US_BRAND.tenantId, "dcn_zzzzzzzzzzzzzzzzzzzz"));
    const r = await purgeConnections({ ...US_BRAND, source: "system" }, { apply: true, by: "ops", now: NOW, db: w.us, regionDb: w.regionDb, transport, appToken: async () => "made-up-app-token", log: () => {} });
    expect(r.orphans.map((o) => o.email)).toEqual([address("e")]);
    expect(accounts.has("1001")).toBe(true);
    expect(accounts.has("2002")).toBe(true);
    expect((await getOrganisationConnection(ORG, OCN, "eu", { regionDb: w.regionDb }))!.parts.map((p) => p.tenantId)).toEqual([EU_BRAND.tenantId]);
    expect(r.removed.find((x) => x.connectionId === USE_US)).toMatchObject({ revoked: false, addressDeleted: null });
  });

  it("keeps a copy's tag apart: another copy's address with the same organisation is never touched", async () => {
    await purgeOrganisations(ORG, opts(true));
    expect(accounts.get("4004")?.description).toContain(`copy=0000000000000000`);
    expect(copyTag()).not.toBe("0000000000000000");
  });
});

describe("resealing organisation secrets", () => {
  it("counts and reseals them in each region, bound to the organisation", async () => {
    const before = await resealOrganisationRegion("eu", { apply: false, db: w.eu });
    expect(before).toMatchObject({ tenantId: "organisations:eu", connections: 2, secrets: 1, offCurrent: 0 });
    vi.stubEnv("CONNECTORS_VAULT_KEY_PREVIOUS", "purge-orgs-vault-root-0123456789abcdef01");
    vi.stubEnv("CONNECTORS_VAULT_KEY", "purge-orgs-vault-root-new-0123456789abcd");
    expect((await resealOrganisationRegion("eu", { apply: false, db: w.eu })).offCurrent).toBe(1);
    expect((await resealOrganisationRegion("eu", { apply: true, db: w.eu })).resealed).toBe(1);
    expect((await resealOrganisationRegion("eu", { apply: false, db: w.eu })).offCurrent).toBe(0);
    const stored = (await getOrganisationConnection(ORG, OCN, "eu", { regionDb: w.regionDb }))!;
    expect(openConnectorSecret(ORG, OCN, "token", stored.secrets.token!)).toBe("made-up-org-token");
  });
});
