import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { shapeRecordingFirestore } from "@/lib/tenant/testing/queryShape";
import { createDataConnection, type NewDataConnection } from "@/lib/tenant";
import type { Tenant } from "@/lib/types/tenant";
import { healthyAt } from "../health";
import { isLaneTick, LANE, runConnectorsLane } from "./tick";

// The lane across brands, with the collect of one connection stubbed: which brands it visits, in
// what order, what it skips, and when it runs at all. No provider is called.
const LANE_TICK = 7 * LANE.TICK_MS; // Math.floor(t / 120_000) % 15 === 7
const tenant = (id: string, over: Partial<Tenant> = {}) => ({ id, region: "us", status: "active", ...over }) as Tenant;

let db: FakeFirestore;
const conn = (id: string, over: Partial<NewDataConnection> = {}): NewDataConnection => ({
  id,
  connectorId: "cloudflare",
  method: "token_fields",
  label: "Cloudflare",
  account: "0123456789abcdef0123456789abcdef",
  ownerUid: "usr_admin",
  grants: [],
  secrets: {},
  health: healthyAt(new Date(LANE_TICK - 86_400_000)),
  pausedAt: null,
  pausedBy: null,
  status: "connected",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  disconnectedAt: null,
  ...over,
});

beforeEach(() => {
  db = new FakeFirestore();
  vi.stubEnv("CONNECTORS_ENABLED", "true");
  vi.stubEnv("CONNECTORS_COLLECT_ENABLED", "true");
  vi.stubEnv("CONNECTOR_CLOUDFLARE_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("the connectors lane", () => {
  it("runs on every 15th tick at offset 7, never on the other lanes' ticks", () => {
    expect(isLaneTick(LANE_TICK)).toBe(true);
    expect(isLaneTick(LANE_TICK + LANE.TICK_MS)).toBe(false);
    expect(isLaneTick(LANE_TICK + 15 * LANE.TICK_MS)).toBe(true);
    // Competitor scans and search sweeps run on multiples of 5 and 15.
    for (let n = 0; n < 150; n += 5) expect(isLaneTick(n * LANE.TICK_MS)).toBe(false);
  });

  it("does nothing off its tick, or with the core off", async () => {
    const listTenants = vi.fn(async () => [tenant("ten_a")]);
    expect(await runConnectorsLane({ deadlineMs: LANE_TICK + LANE.TICK_MS + 25_000 }, { listTenants, clock: () => LANE_TICK + LANE.TICK_MS })).toMatchObject({ brands: 0 });
    vi.stubEnv("CONNECTORS_ENABLED", "false");
    expect(await runConnectorsLane({ deadlineMs: LANE_TICK + 25_000 }, { listTenants, clock: () => LANE_TICK })).toMatchObject({ brands: 0 });
    expect(listTenants).not.toHaveBeenCalled();
  });

  it("takes turns from a rotating offset, skips suspended brands, and collects only due connections", async () => {
    for (const t of ["ten_a", "ten_b", "ten_c"]) await createDataConnection({ tenantId: t, region: "us", source: "system" }, conn(`dcn_${t.slice(4)}aaaaaaaaaaaaaaaaaaa`), [], db);
    await createDataConnection({ tenantId: "ten_a", region: "us", source: "system" }, conn("dcn_pausedaaaaaaaaaaaaaa", { pausedAt: "2026-11-01T00:00:00.000Z", pausedBy: "usr_admin" }), [], db);
    const seen: string[] = [];
    const collect = vi.fn(async (ctx: { tenantId: string }, id: string) => {
      seen.push(`${ctx.tenantId}:${id}`);
      return { status: "collected" as const, days: 2 };
    });
    const tenants = [tenant("ten_a"), tenant("ten_b", { status: "suspended" }), tenant("ten_c")];
    // The offset moves by one each lane run: this run starts at the second of the two brands left.
    const clock = () => LANE_TICK + LANE.EVERY * LANE.TICK_MS;
    const log = vi.fn();
    const r = await runConnectorsLane({ deadlineMs: clock() + 25_000 }, { db, listTenants: async () => tenants, clock, collect, log });
    expect(seen).toEqual(["ten_c:dcn_caaaaaaaaaaaaaaaaaaa", "ten_a:dcn_aaaaaaaaaaaaaaaaaaaa"]);
    expect(r).toMatchObject({ brands: 2, connections: 2, days: 4, behindMin: 0 });
    expect(log.mock.calls[0]![0]).toContain("oldest due 0 min ago");
  });

  it("reads each brand's connections by equality only, and stops when its time runs short", async () => {
    await createDataConnection({ tenantId: "ten_a", region: "us", source: "system" }, conn("dcn_aaaaaaaaaaaaaaaaaaaa"), [], db);
    const ops: string[] = [];
    let t = LANE_TICK;
    const collect = vi.fn(async () => {
      t += 20_000;
      return { status: "nothing" as const, days: 0 };
    });
    const r = await runConnectorsLane({ deadlineMs: LANE_TICK + 25_000 }, { db: shapeRecordingFirestore(db, ops), listTenants: async () => [tenant("ten_a"), tenant("ten_b")], clock: () => t, collect, log: () => {} });
    expect(ops.every((o) => o.endsWith(" ==")), ops.join(", ")).toBe(true);
    expect(r.brands).toBe(1);
  });

  it("collects nothing with collect off, but still visits the brands for their housekeeping", async () => {
    vi.stubEnv("CONNECTORS_COLLECT_ENABLED", "false");
    await createDataConnection({ tenantId: "ten_a", region: "us", source: "system" }, conn("dcn_aaaaaaaaaaaaaaaaaaaa"), [], db);
    const collect = vi.fn();
    const housekeeping = vi.fn(async () => ({ erased: 1 }));
    const r = await runConnectorsLane({ deadlineMs: LANE_TICK + 25_000 }, { db, listTenants: async () => [tenant("ten_a")], clock: () => LANE_TICK, collect, housekeeping, log: () => {} });
    expect(collect).not.toHaveBeenCalled();
    expect(housekeeping).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ brands: 1, erased: 1, connections: 0 });
  });
});
