import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { createDataConnection, type TenantContext } from "@/lib/tenant";
import { numberKeys } from "@/lib/metrics/meanings";
import type { ConnectionGrant, DataConnection } from "@/lib/types/dataConnection";
import { agentConnections, agentLiveRead, NO_AGENT_GRANT } from "./agentApi";
import type { ConnectorActor } from "./grants";
import { connect, setGrants } from "./service";

// What Vizzy reads, below the routes: who may see and read what, and why not in words. No
// provider is called here: every read below is refused before one, or answered by a stub transport.
const A: TenantContext = { tenantId: "ten_a", region: "us", source: "agent", userId: "usr_x", role: "member" };
const forAdmin: ConnectorActor = { kind: "agent", agent: "vizzy", forRole: "admin" };
const forMember: ConnectorActor = { kind: "agent", agent: "vizzy", forRole: "member" };
const T0 = "2026-11-20T10:00:00.000Z";
const NOW = new Date("2026-11-21T10:00:00.000Z");
const VIZZY: ConnectionGrant[] = [{ to: "agent:vizzy", can: "read" }];

let db: FakeFirestore;
async function seed(
  id: string,
  over: { connectorId?: string; account?: string; grants?: ConnectionGrant[]; status?: "connected" | "disconnected"; pausedAt?: string | null; health?: DataConnection["health"] } = {},
) {
  await createDataConnection(
    A,
    {
      id,
      connectorId: over.connectorId ?? "search-console",
      method: "share_access",
      label: "Our site",
      account: over.account ?? "sc-domain:example.com",
      ownerUid: "usr_admin",
      grants: over.grants ?? VIZZY,
      secrets: {},
      serviceAccount: { email: `ygc-${"a".repeat(20)}@made-up-identities.iam.gserviceaccount.com`, uniqueId: "1", createdAt: T0, deletedAt: null },
      health: over.health ?? { state: "ok", lastOkAt: T0, lastCheckedAt: T0, lastErrorCode: null, failures: 0, pausedUntil: null },
      pausedAt: over.pausedAt ?? null,
      pausedBy: over.pausedAt ? "usr_admin" : null,
      status: over.status ?? "connected",
      createdAt: T0,
      updatedAt: T0,
      disconnectedAt: over.status === "disconnected" ? T0 : null,
    },
    [{ kind: "shared", by: "usr_admin", at: T0 }],
    db,
  );
}

beforeEach(() => {
  db = new FakeFirestore();
  vi.stubEnv("CONNECTORS_ENABLED", "true");
  vi.stubEnv("CONNECTOR_SEARCH_CONSOLE_ENABLED", "true");
  vi.stubEnv("CONNECTOR_GA4_ENABLED", "true");
  vi.stubEnv("CONNECTORS_IDENTITIES_PROJECT", "made-up-identities");
});
afterEach(() => vi.unstubAllEnvs());

describe("list_connections", () => {
  it("says why Vizzy can't read each one it sees, and lists no disconnected one", async () => {
    await seed("dcn_aaaaaaaaaaaaaaaaaaaa", { account: "" });
    await seed("dcn_bbbbbbbbbbbbbbbbbbbb", { pausedAt: T0 });
    await seed("dcn_cccccccccccccccccccc", { connectorId: "google-analytics", account: "properties/1000" });
    await seed("dcn_dddddddddddddddddddd", { status: "disconnected" });
    vi.stubEnv("CONNECTOR_GA4_ENABLED", "false");
    const r = await agentConnections(A, forAdmin, { db, now: NOW });
    const byId = Object.fromEntries((r.body.connections as Array<{ id: string; cannotReadBecause: string | null; health: string; streams: unknown[] }>).map((c) => [c.id, c]));
    expect(Object.keys(byId).sort()).toEqual(["dcn_aaaaaaaaaaaaaaaaaaaa", "dcn_bbbbbbbbbbbbbbbbbbbb", "dcn_cccccccccccccccccccc"]);
    expect(byId.dcn_aaaaaaaaaaaaaaaaaaaa!.cannotReadBecause).toBe("Pick which site or property this connection reads first.");
    expect(byId.dcn_bbbbbbbbbbbbbbbbbbbb!).toMatchObject({ health: "paused", cannotReadBecause: "This connection is paused. An admin can resume it." });
    expect(byId.dcn_cccccccccccccccccccc!.cannotReadBecause).toBe("This connector is turned off in this copy of YouGrow.");
    expect(byId.dcn_cccccccccccccccccccc!.streams).toHaveLength(1);
    expect(r.body.notShared).toBe(false);
    expect([...numberKeys(r.body)]).toEqual([]);
  });

  it("says a turned down token in its tool's words, naming Vizzy", async () => {
    vi.stubEnv("CONNECTOR_CLOUDFLARE_ENABLED", "true");
    const health = { state: "broken" as const, lastOkAt: T0, lastCheckedAt: T0, lastErrorCode: "token_refused" as const, failures: 1, pausedUntil: null };
    await seed("dcn_aaaaaaaaaaaaaaaaaaaa", { connectorId: "cloudflare", account: "0123456789abcdef0123456789abcdef", health });
    const r = await agentConnections(A, forAdmin, { db, now: NOW });
    expect((r.body.connections as Array<{ problem: string | null }>)[0]!.problem).toBe("Cloudflare turned the token down. Vizzy can't read it until you reconnect.");
  });

  it("lets Vizzy read for a member only when members may read too", async () => {
    await seed("dcn_aaaaaaaaaaaaaaaaaaaa", { grants: [...VIZZY, { to: "members", can: "read" }] });
    const r = await agentConnections(A, forMember, { db, now: NOW });
    expect((r.body.connections as Array<{ canRead: boolean }>)[0]!.canRead).toBe(true);
  });
});

describe("read_connected_live", () => {
  it("refuses before any provider call when Vizzy has no grant, the connector is off or no site is picked", async () => {
    await seed("dcn_aaaaaaaaaaaaaaaaaaaa", { grants: [] });
    await seed("dcn_bbbbbbbbbbbbbbbbbbbb", { account: "" });
    const q = { stream: "search_performance", from: "2026-11-10", to: "2026-11-10" };
    expect(await agentLiveRead(A, forAdmin, { connectionId: "dcn_aaaaaaaaaaaaaaaaaaaa", ...q }, { db, now: NOW })).toEqual({ status: 403, body: { error: "no_agent_grant", message: NO_AGENT_GRANT } });
    expect(await agentLiveRead(A, forAdmin, { connectionId: "dcn_bbbbbbbbbbbbbbbbbbbb", ...q }, { db, now: NOW })).toMatchObject({ status: 409, body: { error: "account_needed" } });
    vi.stubEnv("CONNECTOR_SEARCH_CONSOLE_ENABLED", "false");
    expect(await agentLiveRead(A, forAdmin, { connectionId: "dcn_bbbbbbbbbbbbbbbbbbbb", ...q }, { db, now: NOW })).toMatchObject({ status: 404, body: { error: "connector_off" } });
  });

  it("says a token Cloudflare turns down during a read in its tool's words, naming Vizzy", async () => {
    vi.stubEnv("CONNECTOR_CLOUDFLARE_ENABLED", "true");
    vi.stubEnv("CONNECTORS_CHAT_ENABLED", "true");
    vi.stubEnv("CONNECTORS_VAULT_KEY", "agent-api-test-vault-root-0123456789abcdef");
    const id = "dcn_cfcfcfcfcfcfcfcfcfcf";
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    // Connecting runs the zone probe, which this stub answers; the read after it is turned down.
    const transport = vi.fn(async () => json({ data: { viewer: { zones: [{ httpRequests1dGroups: [] }] } }, errors: null }));
    const deps = { db, transport, limit: async () => false, log: () => {}, newId: () => id, now: NOW };
    const admin: ConnectorActor = { kind: "human", uid: "usr_admin", role: "admin" };
    const made = await connect(A, admin, "cloudflare", { fields: { zoneId: "0123456789abcdef0123456789abcdef", token: "made-up-cloudflare-token-0000000000" } }, deps);
    expect(made.ok).toBe(true);
    await setGrants(A, admin, id, { grants: VIZZY }, deps);
    transport.mockResolvedValueOnce(json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, 401));
    const r = await agentLiveRead(A, forAdmin, { connectionId: id, stream: "zone_daily", from: "2026-11-20", to: "2026-11-20" }, deps);
    expect(r).toEqual({ status: 502, body: { error: "token_refused", message: "Cloudflare turned the token down. Vizzy can't read it until you reconnect." } });
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
