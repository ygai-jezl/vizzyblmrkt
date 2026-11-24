import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeOrganisationConnection, endPart, forTenant, type SourceRef, type TenantContext } from "@/lib/tenant";
import { timestampFirestore } from "@/lib/tenant/testing/timestampFirestore";
import { freshCollect, type DataConnection } from "@/lib/types/dataConnection";
import type { Region } from "@/lib/types/tenant";
import type { ConnectorActor } from "./grants";
import { check, getForActor, listForActor, setPaused, type ConnectionView } from "./service";
import { sealConnectorSecret } from "./vault";
import { brandDeps, EU_BRAND, OCN, ORG, orgWorld, seedFernhill, seedOrganisation, seedPart, seedSource, seedTenant, T0, US_BRAND, USE_EU, USE_US, type OrgWorld } from "./testing/organisation";

// The brand's side of a part (Connectors 3, group 3): what Fernhill US's Connected view is given
// for the Cloudflare zone Fernhill Group [made up] gives it. The sign in is kept in Europe and the
// brand in the United States, one fake database per region. Cloudflare is a stub.
const ZONE = "0123456789abcdef0123456789abcd01";
const ZONE_EU = "0123456789abcdef0123456789abcd02";
const NOW = new Date("2026-11-24T12:00:00.000Z");
const CTX: TenantContext = { ...US_BRAND, source: "idtoken", userId: "usr_leo", role: "admin" };
const admin: ConnectorActor = { kind: "human", uid: "usr_leo", role: "admin" };
const member: ConnectorActor = { kind: "human", uid: "usr_sam", role: "member" };

let w: OrgWorld;
let source: SourceRef;
let transport: ReturnType<typeof vi.fn>;
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const deps = () => ({ ...brandDeps(w, US_BRAND), transport, limit: async () => false, log: () => {}, now: NOW });
const collected = { ...freshCollect(), lastDay: "2026-11-22", backfilledTo: "2026-08-25", filled: true, timeZone: "UTC" };

async function list(actor: ConnectorActor = admin): Promise<ConnectionView[]> {
  const r = await listForActor(CTX, actor, deps());
  if (!r.ok) throw new Error(r.error);
  return r.value.connections;
}
const one = async (actor: ConnectorActor = admin) => (await list(actor)).find((c) => c.id === USE_US)!;
const setSource = (patch: Record<string, unknown>) => changeOrganisationConnection(ORG, OCN, "eu", () => ({ patch, activity: [] }), { regionDb: w.regionDb });
const setRecord = (patch: Partial<DataConnection>) => w.us.seed("data_connections", USE_US, { ...(w.us.raw("data_connections", USE_US) as Record<string, unknown>), ...patch });

beforeEach(async () => {
  vi.stubEnv("CONNECTORS_VAULT_KEY", "part-views-test-vault-root-0123456789ab");
  vi.stubEnv("CONNECTORS_ENABLED", "true");
  vi.stubEnv("CONNECTOR_CLOUDFLARE_ENABLED", "true");
  vi.stubEnv("PLANS_ENABLED", "true");
  vi.stubEnv("CONNECTORS_SHARING_ENABLED", "true");
  vi.stubEnv("CONNECTORS_COLLECT_ENABLED", "true");
  transport = vi.fn(async () => answer({ data: { viewer: { zones: [{ httpRequests1dGroups: [] }] } }, errors: null }));
  w = orgWorld();
  seedFernhill(w);
  source = await seedSource(w, { secrets: { token: sealConnectorSecret(ORG, OCN, "token", "made-up-org-token", new Date(T0)) } });
  await seedPart(w, source, US_BRAND, { useId: USE_US, account: ZONE, collect: collected });
});
afterEach(() => vi.unstubAllEnvs());

describe("a part on its brand's Connected view", () => {
  it("names the organisation that gives it and both regions, and reads like any connection while it is live", async () => {
    const c = await one();
    expect(c.part).toEqual({ organisation: "Fernhill Group", brand: "Fernhill US", reads: "live", since: null, keptIn: "Europe", region: "United States", ended: null });
    expect(c.canReadLive).toBe(true);
    expect(c.details?.collect?.lastDay).toBe("2026-11-22");
    // Nothing of the sign in: no address, no secret, its own grants only.
    expect(c.details).toMatchObject({ serviceAccount: null, secrets: [], account: ZONE });
    expect(JSON.stringify(c)).not.toContain("made-up-org-token");
    expect(JSON.stringify(c)).not.toContain(OCN);
  });

  it("gives a member the organisation's name and state, never the part it reads", async () => {
    const c = await one(member);
    expect(c.details).toBeUndefined();
    expect(c.part).toMatchObject({ organisation: "Fernhill Group", reads: "live" });
    expect(JSON.stringify(c)).not.toContain(ZONE);
  });

  it("reads as broken from when its organisation's sign in stopped, and keeps what it collected readable", async () => {
    await setSource({ health: { state: "broken", lastOkAt: T0, lastCheckedAt: "2026-11-21T08:00:00.000Z", lastErrorCode: "token_refused", failures: 3, pausedUntil: null, since: "2026-11-21T07:00:00.000Z" } });
    const c = await one();
    expect(c.part).toMatchObject({ reads: "source", since: "2026-11-21T07:00:00.000Z" });
    expect(c.health).toMatchObject({ state: "broken", since: "2026-11-21T07:00:00.000Z" });
    expect(c.canReadLive).toBe(true);
    expect(c.details?.collect).not.toBeNull();
  });

  it("reads as paused while its organisation's owners paused it, and the brand's own pause stays its own", async () => {
    await setSource({ pausedAt: "2026-11-23T09:00:00.000Z", pausedBy: "usr_priya" });
    expect((await one()).health.state).toBe("paused");
    expect((await one()).part?.reads).toBe("paused");
    expect((await one()).details?.pausedAt).toBeNull();
    await setSource({ pausedAt: null, pausedBy: null });
    const r = await setPaused(CTX, admin, USE_US, true, deps());
    expect(r).toMatchObject({ ok: true, value: { part: { reads: "live" }, details: { pausedBy: "usr_leo" } } });
  });

  it("drops a code it recorded while its source couldn't serve it, once it reads again", async () => {
    setRecord({ health: { state: "check", lastOkAt: T0, lastCheckedAt: T0, lastErrorCode: "source_broken", failures: 1, pausedUntil: null, since: T0 } });
    expect((await one()).health).toMatchObject({ state: "ok", message: null });
    // A failure of its own part stays.
    setRecord({ health: { state: "broken", lastOkAt: T0, lastCheckedAt: T0, lastErrorCode: "account_refused", failures: 2, pausedUntil: null, since: "2026-11-22T06:00:00.000Z" } });
    expect((await one()).health).toMatchObject({ state: "broken", since: "2026-11-22T06:00:00.000Z" });
  });

  it("with sharing off, still names its organisation, but reads nothing and shows nothing collected", async () => {
    vi.stubEnv("CONNECTORS_SHARING_ENABLED", "false");
    const c = await one();
    expect(c.part).toMatchObject({ organisation: "Fernhill Group", reads: "off" });
    expect(c.canReadLive).toBe(false);
    expect(c.details?.collect).toBeNull();
    expect((await one(member)).collectedTo).toBeNull();
    // Plans off reads nothing too, and ends nothing.
    vi.stubEnv("CONNECTORS_SHARING_ENABLED", "true");
    vi.stubEnv("PLANS_ENABLED", "false");
    expect((await one()).part?.reads).toBe("off");
    expect((await forTenant(CTX, w.us).dataConnections.getById(USE_US))?.status).toBe("connected");
  });

  it("reads nothing once the brand left the organisation, before housekeeping ends it", async () => {
    seedTenant(w, US_BRAND, "org_ten_fernhill-us");
    seedOrganisation(w, "org_ten_fernhill-us", [US_BRAND.tenantId], ["usr_priya"], "Fernhill US Shop");
    const c = await one();
    // The part still names the organisation that gave it, not the one the brand is in now.
    expect(c.part).toMatchObject({ organisation: "Fernhill Group", reads: "ended" });
    expect(c.canReadLive).toBe(false);
    expect(c.details?.collect).toBeNull();
  });

  it("says a give that hasn't finished, and a check that couldn't be made, read nothing", async () => {
    await changeOrganisationConnection(ORG, OCN, "eu", (cur) => ({ patch: { parts: cur.parts.map((p) => ({ ...p, state: "pending" as const })) }, activity: [] }), { regionDb: w.regionDb });
    expect((await one()).part?.reads).toBe("pending");
    const down = { ...deps(), regionDb: (r: Region) => (r === "eu" ? broken() : w.regionDb(r)) };
    const r = await listForActor(CTX, admin, down);
    expect(r.ok && r.value.connections[0]!.part).toMatchObject({ reads: "unknown", organisation: "Fernhill Group" });
  });

  it("says how a part ended, from its own activity, and who it named", async () => {
    await endPart({ source, brand: US_BRAND, useId: USE_US, by: "system", at: "2026-11-24T10:00:00.000Z", code: "left" }, { regionDb: w.regionDb });
    const c = await one();
    expect(c.status).toBe("disconnected");
    expect(c.part).toMatchObject({ organisation: "Fernhill Group", brand: "Fernhill US", reads: "ended", ended: { why: "left", at: "2026-11-24T10:00:00.000Z" } });
  });

  it("never names another brand's part, or another organisation's", async () => {
    await seedPart(w, source, EU_BRAND, { useId: USE_EU, account: ZONE_EU });
    const views = await list();
    expect(views.map((c) => c.id)).toEqual([USE_US]);
    expect(JSON.stringify(views)).not.toContain(ZONE_EU);
    expect(JSON.stringify(views)).not.toContain("Fernhill Plants");
  });

  it("answers Check now's source failure with who can fix it, by name", async () => {
    transport.mockResolvedValue(answer({ data: null, errors: [{ message: "Unauthorized" }] }));
    const r = await check(CTX, admin, USE_US, deps());
    expect(r).toMatchObject({ ok: true, value: { check: { ok: false, code: "source_broken", message: "Cloudflare for Fernhill US comes from Fernhill Group, and its sign in needs attention. An owner of Fernhill Group can fix it." } } });
    expect(r.ok && r.value.connection.part?.reads).toBe("source");
  });

  it("reads the same from databases that keep dates as Firestore does", async () => {
    w = { ...w, us: timestampFirestore(w.us), eu: timestampFirestore(w.eu) } as OrgWorld;
    w.regionDb = (r) => (r === "eu" ? w.eu : r === "asia" ? w.asia : w.us);
    const r = await getForActor(CTX, admin, USE_US, deps());
    expect(r).toMatchObject({ ok: true, value: { part: { reads: "live", keptIn: "Europe" } } });
  });
});

/** A database whose every read fails, as one that can't be reached. */
function broken(): never {
  const fail = () => {
    throw new Error("unreachable");
  };
  return { collection: fail, runTransaction: fail, batch: fail } as never;
}
