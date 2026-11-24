import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant";
import { connectedCount, connectionsScreenFor } from "./screens";
import { connect } from "./service";

// No provider is called: the one connect below goes through a stub transport.
const ADMIN: TenantContext = { tenantId: "ten_a", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const MEMBER: TenantContext = { ...ADMIN, userId: "usr_member", role: "member" };
const ZONE = "0123456789abcdef0123456789abcdef";
const PROBE_OK = { data: { viewer: { zones: [{ httpRequests1dGroups: [] }] } }, errors: null };

let db: FakeFirestore;
const deps = () => ({
  db,
  transport: vi.fn(async () => new Response(JSON.stringify(PROBE_OK), { status: 200, headers: { "content-type": "application/json" } })),
  limit: async () => false,
  log: () => {},
  newId: () => "dcn_aaaaaaaaaaaaaaaaaaaa",
  now: new Date("2026-11-21T10:00:00.000Z"),
});

beforeEach(() => {
  db = new FakeFirestore();
  vi.stubEnv("CONNECTORS_ENABLED", "true");
  vi.stubEnv("CONNECTOR_CLOUDFLARE_ENABLED", "true");
  vi.stubEnv("CONNECTORS_VAULT_KEY", "screens-test-vault-root-0123456789abcdef");
});
afterEach(() => vi.unstubAllEnvs());

describe("what the Connections screens start from", () => {
  it("gives an admin the offered connectors and every detail but secrets", async () => {
    await connect(ADMIN, { kind: "human", uid: "usr_admin", role: "admin" }, "cloudflare", { fields: { zoneId: ZONE, token: "made-up-cloudflare-token-0000000000" } }, deps());
    const s = await connectionsScreenFor(ADMIN, deps());
    expect(s).toMatchObject({ core: true, chat: false, isAdmin: true, uid: "usr_admin", failed: false });
    expect(s.connectors.map((c) => c.id)).toEqual(["cloudflare"]);
    expect(s.connections).toHaveLength(1);
    expect(s.connections[0]!.details).toMatchObject({ account: ZONE, grants: [] });
    expect(JSON.stringify(s)).not.toContain("made-up-cloudflare-token");
    expect(connectedCount(s)).toBe(1);
  });

  it("gives a member name and health only", async () => {
    await connect(ADMIN, { kind: "human", uid: "usr_admin", role: "admin" }, "cloudflare", { fields: { zoneId: ZONE, token: "made-up-cloudflare-token-0000000000" } }, deps());
    const s = await connectionsScreenFor(MEMBER, deps());
    expect(s.isAdmin).toBe(false);
    expect(s.connections[0]!.details).toBeUndefined();
    expect(s.connections[0]!.health.state).toBe("ok");
  });

  it("reads nothing with the core switch off, and says the Vizzy grant is offered only with chat on", async () => {
    vi.stubEnv("CONNECTORS_ENABLED", "false");
    const off = await connectionsScreenFor(ADMIN, deps());
    expect(off).toMatchObject({ core: false, connectors: [], connections: [], failed: false });
    vi.stubEnv("CONNECTORS_ENABLED", "true");
    vi.stubEnv("CONNECTORS_CHAT_ENABLED", "true");
    expect((await connectionsScreenFor(ADMIN, deps())).chat).toBe(true);
  });

  it("says it failed when the list can't be read", async () => {
    const broken = { ...deps(), db: { collection: () => { throw new Error("down"); } } as unknown as FakeFirestore };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await connectionsScreenFor(ADMIN, broken)).toMatchObject({ core: true, failed: true, connections: [] });
  });

  it("offers Fix on a part only to an admin the server found to own the organisation", async () => {
    expect((await connectionsScreenFor(ADMIN, deps())).owner).toBe(false);
    expect((await connectionsScreenFor(ADMIN, deps(), { owner: true })).owner).toBe(true);
    // A member who owns the organisation still can't act here.
    expect((await connectionsScreenFor(MEMBER, deps(), { owner: true })).owner).toBe(false);
  });

  it("counts only connected connections", () => {
    expect(connectedCount({ connections: [{ status: "connected" }, { status: "disconnected" }] as never })).toBe(1);
  });
});
