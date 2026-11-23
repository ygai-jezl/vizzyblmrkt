import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { changeDataConnection, createDataConnection, forTenant, type NewDataConnection, type TenantContext } from "@/lib/tenant";
import { DataConnectionSchema } from "@/lib/types/dataConnection";
import { healthyAt } from "../health";
import { answer, cfDays, cfSettings, routedTransport, SC_QUOTA, scDays, scRows, type SeenCall } from "../testing/providers";
import { ACCESS_SLOT, REFRESH_SLOT } from "../tokenKeeper";
import { sealConnectorSecret } from "../vault";
import { listForActor } from "../service";
import { collectConnection, isDue } from "./run";

// One connection's daily collect against stub providers: Cloudflare with a pasted token, and
// Search Console signed in with Google. Every number and site is made up.
const A: TenantContext = { tenantId: "ten_a", region: "us", source: "system" };
const CF = "dcn_cccccccccccccccccccc";
const SC = "dcn_ssssssssssssssssssss";
const ZONE = "0123456789abcdef0123456789abcdef";
const NOW = new Date("2026-11-23T12:00:00.000Z");
const DEADLINE = NOW.getTime() + 25_000;

let db: FakeFirestore;
const load = async (id: string) => (await forTenant(A, db).dataConnections.getById(id))!;
const activity = () => db.dump("data_connection_activity").map((a) => `${a.kind}${a.code ? `:${a.code}` : ""}`);

function base(id: string, over: Partial<NewDataConnection>): NewDataConnection {
  const at = new Date(NOW.getTime() - 86_400_000);
  return {
    id,
    connectorId: "cloudflare",
    method: "token_fields",
    label: "Cloudflare",
    account: ZONE,
    ownerUid: "usr_admin",
    grants: [],
    secrets: {},
    health: healthyAt(at),
    pausedAt: null,
    pausedBy: null,
    status: "connected",
    createdAt: at.toISOString(),
    updatedAt: at.toISOString(),
    disconnectedAt: null,
    ...over,
  };
}

async function seedCloudflare(over: Partial<NewDataConnection> = {}) {
  await createDataConnection(A, base(CF, { secrets: { token: sealConnectorSecret("ten_a", CF, "token", "made-up-cloudflare-token-0000000000", NOW) }, ...over }), [], db);
}

async function seedSearchConsole(over: Partial<NewDataConnection> = {}) {
  await createDataConnection(
    A,
    base(SC, {
      connectorId: "search-console",
      method: "oauth_pkce",
      label: "Google Search Console",
      account: "sc-domain:example.com",
      secrets: { [ACCESS_SLOT]: sealConnectorSecret("ten_a", SC, ACCESS_SLOT, "made-up-access", NOW), [REFRESH_SLOT]: sealConnectorSecret("ten_a", SC, REFRESH_SLOT, "made-up-refresh", NOW) },
      tokenExpiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
      refresh: { leaseId: null, leaseUntil: null },
      ...over,
    }),
    [],
    db,
  );
}

const ALL_DAYS = Array.from({ length: 90 }, (_, i) => new Date(Date.parse("2026-08-24") + i * 86_400_000).toISOString().slice(0, 10));
const cloudflare = () => routedTransport((c: SeenCall) => (String(c.body.query).includes("settings") ? answer(cfSettings()) : answer(cfDays(ALL_DAYS, ALL_DAYS.slice(-30)))));
const run = (transport: ReturnType<typeof routedTransport>["transport"], over: { now?: Date; force?: boolean } = {}) =>
  collectConnection(A, CF, { deadlineMs: (over.now ?? NOW).getTime() + 25_000, force: over.force }, { db, transport, limit: async () => false, log: () => {}, now: over.now ?? NOW, newLeaseId: () => "lease-1" });

beforeEach(() => {
  db = new FakeFirestore();
  vi.stubEnv("CONNECTORS_ENABLED", "true");
  vi.stubEnv("CONNECTORS_COLLECT_ENABLED", "true");
  vi.stubEnv("CONNECTOR_CLOUDFLARE_ENABLED", "true");
  vi.stubEnv("CONNECTOR_SEARCH_CONSOLE_ENABLED", "true");
  vi.stubEnv("CONNECTOR_GOOGLE_CLIENT_ID", "made-up-client.example.test");
  vi.stubEnv("CONNECTOR_GOOGLE_CLIENT_SECRET", "made-up-client-secret");
  vi.stubEnv("CONNECTORS_VAULT_KEY", "collect-test-vault-root-0123456789abcdef");
});
afterEach(() => vi.unstubAllEnvs());

describe("collecting one connection", () => {
  it("fills 90 days in one run as a system job, moves the cursor and gives the lease back", async () => {
    await seedCloudflare();
    const { transport, calls } = cloudflare();
    expect(await run(transport)).toEqual({ status: "collected", days: 90 });
    expect(calls).toHaveLength(2);
    // 90 day docs, and the rolled 28 and 90 days.
    expect(db.dump("metric_snapshots").filter((d) => d.day)).toHaveLength(90);
    const c = (await load(CF)).collect!;
    expect(c).toMatchObject({ gen: 0, lastDay: "2026-11-21", backfilledTo: "2026-08-24", finalThrough: "2026-11-21", filled: true, leaseId: null, leaseUntil: null, failedSince: null, timeZone: "UTC" });
    // The next day is due at 03:00 UTC two days on, spread over the hour.
    expect(Date.parse(c.nextAt!)).toBeGreaterThanOrEqual(Date.parse("2026-11-24T03:00:00.000Z"));
    expect(Date.parse(c.nextAt!)).toBeLessThan(Date.parse("2026-11-24T04:00:00.000Z"));
    // The collected row is kept in the log, never on the recent list (an older build can still read the record).
    expect(activity()).toEqual(["collected"]);
    const raw = db.raw("data_connections", CF)!;
    expect((raw.recent as Array<{ kind: string }>).map((e) => e.kind)).not.toContain("collected");
    expect(DataConnectionSchema.omit({ collect: true }).safeParse({ ...raw, id: CF }).success).toBe(true);
  });

  it("shows admins how far it is collected, members only the last day, and nothing with collect off", async () => {
    await seedCloudflare({ grants: [{ to: "members", can: "read" }] });
    await run(cloudflare().transport);
    const admin = await listForActor(A, { kind: "human", uid: "usr_admin", role: "admin" }, { db, now: NOW });
    const view = admin.ok ? admin.value.connections[0]! : null;
    expect(view?.collectedTo).toBe("2026-11-21");
    expect(view?.details?.collect).toMatchObject({ lastDay: "2026-11-21", keptFrom: "2026-08-24", days: 90, keepDays: 90, filled: true, timeZone: "UTC", feedsPlanning: false, waitingFor: null });
    const member = await listForActor(A, { kind: "human", uid: "usr_member", role: "member" }, { db, now: NOW });
    expect(member.ok && member.value.connections[0]).toMatchObject({ collectedTo: "2026-11-21" });
    expect(member.ok && member.value.connections[0]!.details).toBeUndefined();
    vi.stubEnv("CONNECTORS_COLLECT_ENABLED", "false");
    const off = await listForActor(A, { kind: "human", uid: "usr_admin", role: "admin" }, { db, now: NOW });
    expect(off.ok && off.value.connections[0]).toMatchObject({ collectedTo: null, details: { collect: null } });
  });

  it("rolls the 28 and 90 days once a day after a day lands, never adding day docs on a read", async () => {
    await seedCloudflare();
    await run(cloudflare().transport);
    expect(db.dump("metric_snapshots")).toHaveLength(92);
    const r90 = db.raw("metric_snapshots", `${CF}_0_zone_daily_day_r90`)!;
    expect(r90).toMatchObject({ window: { from: "2026-08-24", to: "2026-11-21" }, days: 90, basis: "mixed", totals: { cfUniqueVisitors: null, cfVisits: null } });
    expect((await load(CF)).collect?.rolledOn).toBe("2026-11-23");
    // A later run the same day lands a day but leaves the rolled docs for tomorrow.
    await changeDataConnection(A, CF, (cur) => ({ patch: { collect: { ...cur.collect!, nextAt: null } }, activity: [] }), db);
    const before = db.writeCountFor("metric_snapshots", `${CF}_0_zone_daily_day_r28`);
    const later = new Date("2026-11-23T23:00:00.000Z");
    const next = routedTransport((c) => (String(c.body.query).includes("settings") ? answer(cfSettings()) : answer(cfDays(["2026-11-21"], ["2026-11-21"]))));
    await run(next.transport, { now: later, force: true });
    expect(db.writeCountFor("metric_snapshots", `${CF}_0_zone_daily_day_r28`)).toBe(before);
  });

  it("collects nothing more until the next day is due, then only the new day", async () => {
    await seedCloudflare();
    await run(cloudflare().transport);
    const again = cloudflare();
    expect(await run(again.transport)).toEqual({ status: "skipped", days: 0 });
    expect(again.calls).toHaveLength(0);
    const tomorrow = new Date("2026-11-24T12:00:00.000Z");
    const next = routedTransport((c) => (String(c.body.query).includes("settings") ? answer(cfSettings()) : answer(cfDays(["2026-11-22"], ["2026-11-22"]))));
    expect(await run(next.transport, { now: tomorrow })).toEqual({ status: "collected", days: 1 });
    expect(next.calls[1]!.body.variables).toMatchObject({ from: "2026-11-22", to: "2026-11-22" });
    // The day 90 days before the new one left by id.
    expect(db.dump("metric_snapshots").some((d) => d.day === "2026-08-24")).toBe(false);
    expect((await load(CF)).collect).toMatchObject({ lastDay: "2026-11-22", backfilledTo: "2026-08-25" });
  });

  it("skips a paused, a turned down and a leased connection, and one with no site picked", async () => {
    const { transport, calls } = cloudflare();
    await seedCloudflare({ pausedAt: NOW.toISOString(), pausedBy: "usr_admin" });
    expect((await run(transport)).status).toBe("skipped");
    await changeDataConnection(A, CF, () => ({ patch: { pausedAt: null, health: { ...healthyAt(NOW), state: "broken" } }, activity: [] }), db);
    expect((await run(transport)).status).toBe("skipped");
    await changeDataConnection(A, CF, () => ({ patch: { health: healthyAt(NOW), collect: { ...(DataConnectionSchema.shape.collect.unwrap().parse({})), leaseId: "other", leaseUntil: new Date(NOW.getTime() + 30_000).toISOString() } }, activity: [] }), db);
    expect((await run(transport, { force: true })).status).toBe("skipped");
    expect(calls).toHaveLength(0);
    expect(isDue({ ...(await load(CF)), account: "", collect: undefined }, NOW)).toBe(false);
  });

  it("holds itself back on a quota answer and leaves the connection's health alone", async () => {
    await seedSearchConsole({ collect: { ...DataConnectionSchema.shape.collect.unwrap().parse({}), lastDay: "2026-11-17", backfilledTo: "2026-08-20", finalThrough: "2026-11-17", filled: true } });
    const quota = routedTransport((c) => ((c.body.dimensions as string[])[0] === "date" ? answer(scDays([{ day: "2026-11-20", clicks: 3, impressions: 90 }])) : answer(SC_QUOTA, 403)));
    const r = await collectConnection(A, SC, { deadlineMs: DEADLINE }, { db, transport: quota.transport, limit: async () => false, log: () => {}, now: NOW });
    expect(r).toMatchObject({ status: "held", code: "rate_limited" });
    const conn = await load(SC);
    expect(conn.health).toMatchObject({ state: "ok", pausedUntil: null });
    expect(conn.collect).toMatchObject({ holdReason: "quota", holdUntil: new Date(NOW.getTime() + 15 * 60_000).toISOString(), strikes: { quota: 1 }, failedSince: null });
    // A second quota answer the same Pacific day holds it to the next Pacific midnight.
    const later = new Date(NOW.getTime() + 20 * 60_000);
    await collectConnection(A, SC, { deadlineMs: later.getTime() + 25_000 }, { db, transport: quota.transport, limit: async () => false, log: () => {}, now: later });
    expect((await load(SC)).collect).toMatchObject({ holdReason: "quota_day", holdUntil: "2026-11-24T08:00:00.000Z" });
    expect((await load(SC)).health.pausedUntil).toBeNull();
  });

  it("marks a connection Google turned down as broken, as a live read does, and notes when collecting started failing", async () => {
    await seedSearchConsole();
    const refused = routedTransport(() => answer({ error: { status: "PERMISSION_DENIED" } }, 403));
    const r = await collectConnection(A, SC, { deadlineMs: DEADLINE }, { db, transport: refused.transport, limit: async () => false, log: () => {}, now: NOW });
    expect(r).toMatchObject({ status: "failed", code: "account_refused" });
    const conn = await load(SC);
    expect(conn.health).toMatchObject({ state: "broken", lastErrorCode: "account_refused" });
    expect(conn.collect?.failedSince).toBe(NOW.toISOString());
    expect(activity()).toEqual(["failed:account_refused"]);
    expect(isDue(conn, NOW)).toBe(false);
  });

  it("collects Search Console's final days, probing again in 2 hours when no new day shows", async () => {
    await seedSearchConsole({ collect: { ...DataConnectionSchema.shape.collect.unwrap().parse({}), lastDay: "2026-11-20", backfilledTo: "2026-08-23", finalThrough: "2026-11-20", filled: true } });
    const same = routedTransport((c) => ((c.body.dimensions as string[])[0] === "date" ? answer(scDays([{ day: "2026-11-20", clicks: 3, impressions: 90 }])) : answer(scRows([]))));
    expect(await collectConnection(A, SC, { deadlineMs: DEADLINE }, { db, transport: same.transport, limit: async () => false, log: () => {}, now: NOW })).toEqual({ status: "nothing", days: 0 });
    const c = (await load(SC)).collect!;
    expect(c.probes).toEqual({ day: "2026-11-23", count: 1 });
    expect(c.nextAt).toBe(new Date(NOW.getTime() + 2 * 3_600_000).toISOString());
  });

  it("marks for erasing what a run wrote when the connection was disconnected meanwhile", async () => {
    await seedCloudflare();
    const { transport } = routedTransport((c) => {
      if (String(c.body.query).includes("settings")) return answer(cfSettings());
      return answer(cfDays(ALL_DAYS));
    });
    const slow = async (url: string, init: RequestInit) => {
      if (!String(init.body).includes("settings")) await changeDataConnection(A, CF, () => ({ patch: { status: "disconnected", disconnectedAt: NOW.toISOString() }, activity: [] }), db);
      return transport(url, init, { maxRedirects: 0, allowedPorts: [443], timeoutMs: 1000 });
    };
    await collectConnection(A, CF, { deadlineMs: DEADLINE }, { db, transport: slow, limit: async () => false, log: () => {}, now: NOW });
    expect((await load(CF)).collect).toMatchObject({ erasePending: "all", leaseId: null });
  });
});
