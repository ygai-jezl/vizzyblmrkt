import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forTenant, getOrganisationConnection, type SourceRef, type TenantContext } from "@/lib/tenant";
import type { DataConnection } from "@/lib/types/dataConnection";
import type { ConnectorActor } from "./grants";
import { check, checkAccess, disconnect, getForActor, listAccounts, listForActor, pickAccount, STOPPED_USING_MESSAGE } from "./service";
import { startSignIn } from "./signIn";
import { sealConnectorSecret } from "./vault";
import { brandDeps, EU_BRAND, OCN, ORG, OTHER_ORG, orgWorld, seedFernhill, seedPart, seedSource, seedTenant, T0, US_BRAND, USE_US, type OrgWorld } from "./testing/organisation";

vi.mock("@/lib/tenant/searchIndex", async () => {
  const { MemorySearchIndex } = await import("@/lib/search/memoryStore");
  const index = new MemorySearchIndex();
  return { searchStoreFor: (ctx: { tenantId: string }) => index.storeFor(ctx) };
});

// A brand admin's side of a part (Connectors 3): Fernhill US, in the United States, reads one
// Cloudflare zone through Fernhill Group's token, kept in Europe. Cloudflare is a stub.
const ZONE = "0123456789abcdef0123456789abcd01";
const NOW = new Date("2026-11-24T12:00:00.000Z");
const CTX: TenantContext = { ...US_BRAND, source: "idtoken", userId: "usr_leo", role: "admin" };
const admin: ConnectorActor = { kind: "human", uid: "usr_leo", role: "admin" };
const member: ConnectorActor = { kind: "human", uid: "usr_sam", role: "member" };

let w: OrgWorld;
let source: SourceRef;
let transport: ReturnType<typeof vi.fn>;
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const deps = () => ({ ...brandDeps(w, US_BRAND), transport, limit: async () => false, log: () => {}, now: NOW });
const part = async () => (await forTenant(CTX, w.us).dataConnections.getById(USE_US)) as DataConnection;
const orgRecord = async () => (await getOrganisationConnection(ORG, OCN, "eu", { regionDb: w.regionDb }))!;

beforeEach(async () => {
  vi.stubEnv("CONNECTORS_VAULT_KEY", "parts-test-vault-root-0123456789abcdef01");
  vi.stubEnv("CONNECTORS_ENABLED", "true");
  vi.stubEnv("CONNECTOR_CLOUDFLARE_ENABLED", "true");
  vi.stubEnv("CONNECTOR_SEARCH_CONSOLE_ENABLED", "true");
  vi.stubEnv("PLANS_ENABLED", "true");
  vi.stubEnv("CONNECTORS_SHARING_ENABLED", "true");
  vi.stubEnv("CONNECTORS_COLLECT_ENABLED", "true");
  transport = vi.fn(async () => answer({ data: { viewer: { zones: [{ httpRequests1dGroups: [] }] } }, errors: null }));
  w = orgWorld();
  seedFernhill(w);
  source = await seedSource(w, { secrets: { token: sealConnectorSecret(ORG, OCN, "token", "made-up-org-token", new Date(T0)) } });
  await seedPart(w, source, US_BRAND, { useId: USE_US, account: ZONE });
});
afterEach(() => vi.unstubAllEnvs());

describe("a brand admin and a part from the organisation", () => {
  it("checks it with the organisation's token, read from Europe, calling Cloudflare with that token", async () => {
    const r = await check(CTX, admin, USE_US, deps());
    expect(r).toMatchObject({ ok: true, value: { check: { ok: true } } });
    expect(((transport.mock.calls[0]![1] as RequestInit).headers as Record<string, string>).authorization).toBe("Bearer made-up-org-token");
  });

  it("puts a token turned down outright on the organisation's record, and source_broken on the brand's", async () => {
    transport.mockResolvedValue(answer({ data: null, errors: [{ message: "Unauthorized" }] }));
    const r = await check(CTX, admin, USE_US, deps());
    expect(r).toMatchObject({ ok: true, value: { check: { ok: false, code: "source_broken" } } });
    expect((await orgRecord()).health).toMatchObject({ state: "broken", lastErrorCode: "token_refused" });
    expect((await part()).health).toMatchObject({ state: "check", lastErrorCode: "source_broken" });
    // The next call is refused before Cloudflare, naming who can fix it.
    transport.mockClear();
    const again = await check(CTX, admin, USE_US, deps());
    expect(again).toMatchObject({ ok: false, status: 409, error: "source_broken" });
    expect(!again.ok && again.message).toBe("Cloudflare for Fernhill US comes from Fernhill Group, and its sign in needs attention. An owner of Fernhill Group can fix it.");
    expect(transport).not.toHaveBeenCalled();
  });

  it("keeps one zone refused on the brand's own record", async () => {
    transport.mockResolvedValue(answer({ data: null, errors: [{ message: `zones [${ZONE}] are not authorized` }] }));
    await check(CTX, admin, USE_US, deps());
    expect((await part()).health).toMatchObject({ state: "broken", lastErrorCode: "account_refused" });
    expect((await orgRecord()).health.state).toBe("ok");
  });

  it("can't list what the sign in sees, pick another part, check access or sign in again", async () => {
    expect(await listAccounts(CTX, admin, USE_US, deps())).toMatchObject({ ok: false, status: 409, error: "managed_by_organisation" });
    expect(await pickAccount(CTX, admin, USE_US, { account: "0123456789abcdef0123456789abcd99" }, deps())).toMatchObject({ ok: false, status: 409, error: "managed_by_organisation" });
    expect(await checkAccess(CTX, admin, USE_US, deps())).toMatchObject({ ok: false, status: 409, error: "managed_by_organisation" });
    vi.stubEnv("CONNECTOR_GOOGLE_CLIENT_ID", "made-up-client.example.test");
    vi.stubEnv("CONNECTOR_GOOGLE_CLIENT_SECRET", "made-up-secret");
    const headers = new Headers({ host: "localhost:3002", "x-forwarded-proto": "http" });
    const r = await startSignIn(CTX, admin, "search-console", { connectionId: USE_US }, headers, deps());
    // The part is Cloudflare, so it isn't this connector's: refused before anything is made.
    expect(r.ok).toBe(false);
    expect(w.us.dump("data_connection_states")).toEqual([]);
    expect(transport).not.toHaveBeenCalled();
  });

  it("refuses Sign in again on a Google part, so a brand admin's tokens never go on it", async () => {
    vi.stubEnv("CONNECTOR_GOOGLE_CLIENT_ID", "made-up-client.example.test");
    vi.stubEnv("CONNECTOR_GOOGLE_CLIENT_SECRET", "made-up-secret");
    const g = await seedSource(w, { id: "ocn_gggggggggggggggggggg", connectorId: "search-console", method: "oauth_pkce", label: "Search Console", signerUid: "usr_priya" });
    // One part per brand per connection: this is a second connection, so the give stands.
    await seedPart(w, g, US_BRAND, { useId: "dcn_gggggggggggggggggggg", account: "sc-domain:fernhill-us.example", connectorId: "search-console", method: "oauth_pkce" });
    const headers = new Headers({ host: "localhost:3002", "x-forwarded-proto": "http" });
    const r = await startSignIn(CTX, admin, "search-console", { connectionId: "dcn_gggggggggggggggggggg" }, headers, deps());
    expect(r).toMatchObject({ ok: false, status: 409, error: "managed_by_organisation" });
    expect(w.us.dump("data_connection_states")).toEqual([]);
  });

  it("shows no details of the source: no address, no secret, its own grants only", async () => {
    const r = await getForActor(CTX, admin, USE_US, deps());
    expect(r.ok && r.value.details).toMatchObject({ account: ZONE, secrets: [], serviceAccount: null });
    expect(JSON.stringify(r)).not.toContain(OCN);
    expect(JSON.stringify(r)).not.toContain("made-up-org-token");
  });
});

describe("Stop using: a brand's Disconnect on a part", () => {
  it("ends the part in three steps, erases what it collected, and never revokes or deletes an address", async () => {
    const r = await disconnect(CTX, admin, USE_US, deps());
    expect(r).toMatchObject({ ok: true, value: { revoked: false, addressDeleted: null, message: STOPPED_USING_MESSAGE } });
    expect(await part()).toMatchObject({ status: "disconnected", secrets: {} });
    expect((await part()).recent[0]).toMatchObject({ kind: "disconnected", code: "stopped_using", by: "usr_leo" });
    expect((await orgRecord()).parts).toEqual([]);
    expect((await orgRecord()).status).toBe("connected");
    expect((await orgRecord()).recent[0]).toMatchObject({ kind: "part_ended", by: "usr_leo", tenantId: US_BRAND.tenantId });
    expect(transport).not.toHaveBeenCalled();
  });

  it("still ends the brand record when the sign in's database is down", async () => {
    const { failingFirestore } = await import("@/lib/tenant/testing/failingFirestore");
    const down = failingFirestore(w.eu, { collections: ["organisation_connections"] });
    const r = await disconnect(CTX, admin, USE_US, { ...deps(), regionDb: (reg: string) => (reg === "eu" ? down : w.regionDb(reg as never)) });
    expect(r.ok).toBe(true);
    expect((await part()).status).toBe("disconnected");
  });

  it("is an admin's only", async () => {
    expect(await disconnect(CTX, member, USE_US, deps())).toMatchObject({ ok: false, status: 403 });
    expect((await part()).status).toBe("connected");
  });
});

describe("the Connected view's collected line", () => {
  it("reads nothing for a part once the brand left, before the erase", async () => {
    const before = await listForActor(CTX, admin, deps());
    expect(before.ok && before.value.connections[0]).toMatchObject({ id: USE_US, canReadLive: true });
    seedTenant(w, US_BRAND, OTHER_ORG);
    const after = await listForActor(CTX, admin, deps());
    expect(after.ok && after.value.connections[0]).toMatchObject({ id: USE_US, canReadLive: false, collectedTo: null });
    // The brand record is still connected: housekeeping ends it on the next lane run.
    expect((await part()).status).toBe("connected");
  });

  it("leaves another brand's parts alone", async () => {
    seedTenant(w, EU_BRAND, OTHER_ORG);
    const r = await listForActor(CTX, admin, deps());
    expect(r.ok && r.value.connections[0]?.canReadLive).toBe(true);
  });
});
