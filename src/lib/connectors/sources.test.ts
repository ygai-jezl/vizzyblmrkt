import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeOrganisationConnection, getOrganisationConnection, type SourceRef } from "@/lib/tenant";
import { failingFirestore } from "@/lib/tenant/testing/failingFirestore";
import { timestampFirestore } from "@/lib/tenant/testing/timestampFirestore";
import type { DataConnection } from "@/lib/types/dataConnection";
import { knownConnector } from "./registry";
import { GOOGLE_TOKEN_URL } from "./google";
import { checkPart, holdSource, partFailure, partLive, PartCache, sourceToken } from "./sources";
import { ACCESS_SLOT, REFRESH_SLOT } from "./tokenKeeper";
import { openConnectorSecret, sealConnectorSecret, VaultOpenError } from "./vault";
import { EU_BRAND, OCN, ORG, OTHER_ORG, orgWorld, seedFernhill, seedOrganisation, seedPart, seedSource, seedTenant, T0, US_BRAND, USE_EU, USE_US, type OrgWorld } from "./testing/organisation";

// A Cloudflare token kept in Europe (connected from Fernhill Plants) gives Fernhill US, in the
// United States, one zone. Nothing reaches a provider: tokens are opened from the vault, and Google's
// token endpoint is a stub.
const ZONE_US = "0123456789abcdef0123456789abcd01";
const ZONE_EU = "0123456789abcdef0123456789abcd02";
const NOW = new Date("2026-11-24T12:00:00.000Z");

let w: OrgWorld;
let source: SourceRef;
const deps = (over: Record<string, unknown> = {}) => ({ db: w.us, controlDb: w.us, regionDb: w.regionDb, now: NOW, ...over });
const usPart = async () => (await import("@/lib/tenant")).forTenant({ ...US_BRAND, source: "system" }, w.us).dataConnections.getById(USE_US) as Promise<DataConnection>;
const ctxUs = { ...US_BRAND };
const cloudflareManifest = knownConnector("cloudflare")!;
const searchConsoleManifest = knownConnector("search-console")!;

beforeEach(async () => {
  vi.stubEnv("CONNECTORS_VAULT_KEY", "sources-test-vault-root-0123456789abcdef0");
  vi.stubEnv("CONNECTORS_ENABLED", "true");
  vi.stubEnv("PLANS_ENABLED", "true");
  vi.stubEnv("CONNECTORS_SHARING_ENABLED", "true");
  w = orgWorld();
  seedFernhill(w);
  source = await seedSource(w, { secrets: { token: sealConnectorSecret(ORG, OCN, "token", "made-up-org-token", new Date(T0)) } });
  await seedPart(w, source, US_BRAND, { useId: USE_US, account: ZONE_US });
});
afterEach(() => vi.unstubAllEnvs());

describe("partLive", () => {
  it("honours an active part that matches the brand record, read from the region its source names", async () => {
    const conn = await usPart();
    expect(conn.source).toEqual({ organisationId: ORG, connectionId: OCN, region: "eu" });
    const before = w.eu.collectionCalls("organisation_connections");
    const check = await partLive(ctxUs, conn, deps());
    expect(check.live).toBe(true);
    // The source was read in Europe only.
    expect(w.us.collectionCalls("organisation_connections")).toBe(0);
    expect(w.eu.collectionCalls("organisation_connections") - before).toBe(1);
  });

  it("refuses, and calls it ended, when the brand left the organisation", async () => {
    seedTenant(w, US_BRAND, OTHER_ORG);
    expect(await partLive(ctxUs, await usPart(), deps())).toMatchObject({ live: false, code: "part_ended", why: "left", ended: true });
    seedTenant(w, US_BRAND, null);
    expect(await partLive(ctxUs, await usPart(), deps())).toMatchObject({ live: false, why: "left", ended: true });
  });

  it("refuses without ending when the organisation no longer lists the brand, or the brand is suspended", async () => {
    seedOrganisation(w, ORG, [EU_BRAND.tenantId]);
    expect(await partLive(ctxUs, await usPart(), deps())).toMatchObject({ live: false, why: "not_listed", ended: false });
    seedOrganisation(w, ORG, [EU_BRAND.tenantId, US_BRAND.tenantId]);
    seedTenant(w, US_BRAND, ORG, { status: "suspended" });
    expect(await partLive(ctxUs, await usPart(), deps())).toMatchObject({ live: false, why: "suspended", ended: false });
  });

  const setPart = (fn: (p: Record<string, unknown>) => Record<string, unknown> | null) =>
    changeOrganisationConnection(ORG, OCN, "eu", (cur) => ({ patch: { parts: cur.parts.map((p) => fn({ ...p })).filter(Boolean) as never }, activity: [] }), { regionDb: w.regionDb });

  it("refuses a part taken back, ending, pending, another part, or another brand record", async () => {
    const conn = await usPart();
    await setPart((p) => ({ ...p, state: "pending" }));
    expect(await partLive(ctxUs, conn, deps())).toMatchObject({ live: false, why: "pending", ended: false });
    await setPart((p) => ({ ...p, state: "ending" }));
    expect(await partLive(ctxUs, conn, deps())).toMatchObject({ live: false, why: "ending", ended: true });
    await setPart((p) => ({ ...p, state: "active", account: ZONE_EU }));
    expect(await partLive(ctxUs, conn, deps())).toMatchObject({ live: false, why: "differs", ended: true });
    await setPart((p) => ({ ...p, account: ZONE_US, useId: USE_EU }));
    expect(await partLive(ctxUs, conn, deps())).toMatchObject({ live: false, why: "differs", ended: true });
    await setPart((p) => ({ ...p, useId: USE_US, region: "eu" }));
    expect(await partLive(ctxUs, conn, deps())).toMatchObject({ live: false, why: "differs", ended: true });
    await setPart(() => null);
    expect(await partLive(ctxUs, conn, deps())).toMatchObject({ live: false, why: "no_part", ended: true });
  });

  it("refuses a source that is disconnected, has another connector or method, or isn't in the region its source names", async () => {
    const conn = await usPart();
    expect(await partLive(ctxUs, { ...conn, connectorId: "search-console" }, deps())).toMatchObject({ live: false, why: "mismatch", ended: true });
    expect(await partLive(ctxUs, { ...conn, method: "share_access" }, deps())).toMatchObject({ live: false, why: "mismatch" });
    expect(await partLive(ctxUs, { ...conn, source: { ...conn.source!, region: "us" } }, deps())).toMatchObject({ live: false, why: "source_missing", ended: true });
    await changeOrganisationConnection(ORG, OCN, "eu", () => ({ patch: { status: "disconnected" }, activity: [] }), { regionDb: w.regionDb });
    expect(await partLive(ctxUs, conn, deps())).toMatchObject({ live: false, why: "source_disconnected", ended: true });
  });

  it("never finds another organisation's record, whatever the brand record names", async () => {
    // Another organisation with its own connection under the same id, in the United States.
    seedOrganisation(w, OTHER_ORG, [US_BRAND.tenantId], ["usr_other"], "Other Co");
    seedTenant(w, US_BRAND, OTHER_ORG);
    const conn = await usPart();
    // The brand now points at the other organisation, but the source names Fernhill's: refused.
    expect(await partLive(ctxUs, conn, deps())).toMatchObject({ live: false, why: "left" });
    expect(await partLive(ctxUs, { ...conn, source: { ...conn.source!, organisationId: OTHER_ORG } }, deps())).toMatchObject({ live: false, why: "source_missing" });
  });

  it("refuses with any of the three switches off, and ends nothing for it", async () => {
    const conn = await usPart();
    for (const name of ["CONNECTORS_SHARING_ENABLED", "PLANS_ENABLED", "CONNECTORS_ENABLED"]) {
      vi.stubEnv(name, "false");
      expect(await partLive(ctxUs, conn, deps())).toMatchObject({ live: false, code: "sharing_off", ended: false });
      // Housekeeping reads the same evidence whatever the switches say: still active, nothing ended.
      expect((await checkPart(ctxUs, conn, deps())).live).toBe(true);
      vi.stubEnv(name, "true");
    }
  });

  it("refuses when the sign in's database can't be read, and ends nothing", async () => {
    const down = failingFirestore(w.eu, { collections: ["organisation_connections"] });
    expect(await partLive(ctxUs, await usPart(), deps({ regionDb: (r: string) => (r === "eu" ? down : w.regionDb(r as never)) }))).toMatchObject({ live: false, code: "busy", why: "read_failed", ended: false });
  });

  it("reads the organisation's record the way Firestore stores it", async () => {
    const tsEu = timestampFirestore(w.eu);
    expect((await partLive(ctxUs, await usPart(), deps({ regionDb: (r: string) => (r === "eu" ? tsEu : w.regionDb(r as never)) }))).live).toBe(true);
  });

  it("reads each document once per cache", async () => {
    const cache = new PartCache();
    const conn = await usPart();
    const before = w.eu.collectionCalls("organisation_connections");
    await partLive(ctxUs, conn, deps({ partCache: cache }));
    await partLive(ctxUs, conn, deps({ partCache: cache }));
    expect(w.eu.collectionCalls("organisation_connections") - before).toBe(1);
  });

  it("checks a token's source is not paused and its sign in works; collected reads go on", async () => {
    const conn = await usPart();
    await changeOrganisationConnection(ORG, OCN, "eu", () => ({ patch: { pausedAt: T0, pausedBy: "usr_priya" }, activity: [] }), { regionDb: w.regionDb });
    expect((await partLive(ctxUs, conn, deps())).live).toBe(true);
    expect(await partLive(ctxUs, conn, deps(), { token: true })).toMatchObject({ live: false, code: "source_paused" });
    await changeOrganisationConnection(ORG, OCN, "eu", (cur) => ({ patch: { pausedAt: null, health: { ...cur.health, state: "broken", lastErrorCode: "token_refused" } }, activity: [] }), { regionDb: w.regionDb });
    expect(await partLive(ctxUs, conn, deps(), { token: true })).toMatchObject({ live: false, code: "source_broken" });
  });

  it("changes no other brand when one is refused", async () => {
    await seedPart(w, source, EU_BRAND, { useId: USE_EU, account: ZONE_EU });
    seedTenant(w, US_BRAND, OTHER_ORG);
    expect((await partLive(ctxUs, await usPart(), deps())).live).toBe(false);
    const eu = (await (await import("@/lib/tenant")).forTenant({ ...EU_BRAND, source: "system" }, w.eu).dataConnections.getById(USE_EU)) as DataConnection;
    expect((await partLive(EU_BRAND, eu, { db: w.eu, controlDb: w.us, regionDb: w.regionDb })).live).toBe(true);
  });
});

describe("sourceToken: a part's token through its organisation", () => {
  it("opens a pasted token with the organisation bound in, read from Europe for a brand in the United States", async () => {
    const conn = await usPart();
    expect(await sourceToken(ctxUs, conn, cloudflareManifest, "system", deps())).toEqual({ ok: true, token: "made-up-org-token" });
  });

  it("ignores any secret on the brand record itself", async () => {
    const conn = { ...(await usPart()), secrets: { token: sealConnectorSecret(US_BRAND.tenantId, USE_US, "token", "made-up-brand-token") } };
    expect(await sourceToken(ctxUs, conn, cloudflareManifest, "system", deps())).toEqual({ ok: true, token: "made-up-org-token" });
  });

  it("marks the organisation's record when its secret won't open, and answers source_broken with who can fix it", async () => {
    await changeOrganisationConnection(ORG, OCN, "eu", () => ({ patch: { secrets: { token: sealConnectorSecret(EU_BRAND.tenantId, OCN, "token", "x") } }, activity: [] }), { regionDb: w.regionDb });
    const r = await sourceToken(ctxUs, await usPart(), cloudflareManifest, "system", deps());
    expect(r).toMatchObject({ ok: false, code: "source_broken", about: { organisation: "Fernhill Group", brand: "Fernhill US" } });
    expect((await getOrganisationConnection(ORG, OCN, "eu", { regionDb: w.regionDb }))!.health).toMatchObject({ state: "broken", lastErrorCode: "secret_unopenable" });
  });

  it("refreshes a Google sign in on the organisation's record, with its lease there", async () => {
    vi.stubEnv("CONNECTOR_GOOGLE_CLIENT_ID", "made-up-client.example.test");
    vi.stubEnv("CONNECTOR_GOOGLE_CLIENT_SECRET", "made-up-client-secret");
    const OCN2 = "ocn_gggggggggggggggggggg";
    const g = await seedSource(w, {
      id: OCN2,
      connectorId: "search-console",
      method: "oauth_pkce",
      label: "Search Console",
      signerUid: "usr_priya",
      tokenExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      refresh: { leaseId: null, leaseUntil: null },
      secrets: { [ACCESS_SLOT]: sealConnectorSecret(ORG, OCN2, ACCESS_SLOT, "made-up-old"), [REFRESH_SLOT]: sealConnectorSecret(ORG, OCN2, REFRESH_SLOT, "made-up-refresh") },
    });
    seedTenant(w, { tenantId: "ten_harbour", region: "eu" }, ORG);
    seedOrganisation(w, ORG, [EU_BRAND.tenantId, US_BRAND.tenantId, "ten_harbour"]);
    await seedPart(w, g, { tenantId: "ten_harbour", region: "eu" }, { useId: "dcn_hhhhhhhhhhhhhhhhhhhh", account: "sc-domain:harbourblooms.example", connectorId: "search-console", method: "oauth_pkce" });
    const conn = (await (await import("@/lib/tenant")).forTenant({ tenantId: "ten_harbour", region: "eu", source: "system" }, w.eu).dataConnections.getById("dcn_hhhhhhhhhhhhhhhhhhhh")) as DataConnection;
    const transport = vi.fn(async (_url: string) => new Response(JSON.stringify({ access_token: "made-up-new", expires_in: 3599, scope: "https://www.googleapis.com/auth/webmasters.readonly", token_type: "Bearer" }), { status: 200 }));
    const r = await sourceToken({ tenantId: "ten_harbour", region: "eu" }, conn, searchConsoleManifest, "system", { db: w.eu, controlDb: w.us, regionDb: w.regionDb, now: NOW, transport });
    expect(r).toEqual({ ok: true, token: "made-up-new" });
    expect(transport.mock.calls[0]![0]).toBe(GOOGLE_TOKEN_URL);
    const stored = (await getOrganisationConnection(ORG, OCN2, "eu", { regionDb: w.regionDb }))!;
    expect(openConnectorSecret(ORG, OCN2, ACCESS_SLOT, stored.secrets[ACCESS_SLOT]!)).toBe("made-up-new");
    expect(stored.refresh).toEqual({ leaseId: null, leaseUntil: null });

    // Google ending the sign in marks the organisation's record, not the brand's.
    await changeOrganisationConnection(ORG, OCN2, "eu", () => ({ patch: { tokenExpiresAt: new Date(NOW.getTime() - 1000).toISOString() }, activity: [] }), { regionDb: w.regionDb });
    const refused = vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    const r2 = await sourceToken({ tenantId: "ten_harbour", region: "eu" }, conn, searchConsoleManifest, "system", { db: w.eu, controlDb: w.us, regionDb: w.regionDb, now: NOW, transport: refused });
    expect(r2).toMatchObject({ ok: false, code: "source_broken" });
    expect((await getOrganisationConnection(ORG, OCN2, "eu", { regionDb: w.regionDb }))!.health).toMatchObject({ state: "broken", lastErrorCode: "signin_refused" });
  });
});

describe("failures: the sign in's go on the organisation's record, a part's stay on its brand", () => {
  it("marks the organisation for a token turned down outright, and reads it as source_broken", async () => {
    const conn = await usPart();
    expect(await partFailure(conn, "token_refused", "system", deps())).toBe("source_broken");
    expect((await getOrganisationConnection(ORG, OCN, "eu", { regionDb: w.regionDb }))!.health.state).toBe("broken");
  });

  it("leaves the organisation alone for one part's account refused, and for a brand's own connection", async () => {
    const conn = await usPart();
    expect(await partFailure(conn, "account_refused", "system", deps())).toBe("account_refused");
    expect(await partFailure({ ...conn, source: undefined }, "token_refused", "system", deps())).toBe("token_refused");
    expect(await partFailure({ ...conn, method: "share_access" }, "token_refused", "system", deps())).toBe("token_refused");
    expect((await getOrganisationConnection(ORG, OCN, "eu", { regionDb: w.regionDb }))!.health.state).toBe("ok");
  });
});

describe("the vault keeps an organisation's secrets and a brand's apart", () => {
  it("never opens an organisation's blob with a brand's binding, nor the other way round", () => {
    const org = sealConnectorSecret(ORG, OCN, "token", "made-up");
    expect(() => openConnectorSecret(EU_BRAND.tenantId, OCN, "token", org)).toThrow(VaultOpenError);
    const brand = sealConnectorSecret(EU_BRAND.tenantId, USE_EU, "token", "made-up");
    expect(() => openConnectorSecret(ORG, USE_EU, "token", brand)).toThrow(VaultOpenError);
    expect(openConnectorSecret(ORG, OCN, "token", org)).toBe("made-up");
  });
});

describe("a quota hold on the shared sign in", () => {
  it("counts Search Console's strikes across brands: the second that day holds to the quota day's end", async () => {
    const day = { day: "2026-11-24", dayUntil: new Date("2026-11-25T08:00:00.000Z") };
    const fifteen = new Date(NOW.getTime() + 15 * 60_000);
    const read = async () => (await getOrganisationConnection(ORG, OCN, "eu", { regionDb: w.regionDb }))!.collectHold;
    // Fernhill US meets the first, 15 minutes.
    await holdSource(source, fifteen, "quota", deps(), day);
    expect(await read()).toEqual({ until: fifteen.toISOString(), reason: "quota", strikes: { day: "2026-11-24", quota: 1 } });
    // Fernhill Plants meets the second the same day: to the next Pacific midnight, whichever brand it was.
    await holdSource(source, fifteen, "quota", deps(), day);
    expect(await read()).toEqual({ until: day.dayUntil.toISOString(), reason: "quota_day", strikes: { day: "2026-11-24", quota: 2 } });
    // A new quota day starts counting again, and a later hold already set stays.
    await holdSource(source, fifteen, "quota", deps(), { day: "2026-11-25", dayUntil: new Date("2026-11-26T08:00:00.000Z") });
    expect(await read()).toEqual({ until: day.dayUntil.toISOString(), reason: "quota_day", strikes: { day: "2026-11-25", quota: 1 } });
  });
});
