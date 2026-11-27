import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { setFieldValues } from "@/lib/audience/fields";
import type { Tenant } from "@/lib/types/tenant";
import type { AgentAction } from "@/lib/types/agentAction";
import { RAISE_FOLLOWUP_ACTION } from "./followups";
import { isFollowUpTick, isMorning, LANE, localHour, runOrder, runRaiseFollowups } from "./followupsTick";
import { archiveStage, boardWorld, type BoardWorld } from "./testing/world";

/** The first lane tick at or after an instant. */
function onTick(iso: string): number {
  const k = Math.floor(Date.parse(iso) / LANE.TICK_MS);
  const at = k - (k % LANE.EVERY) + LANE.OFFSET;
  return (at < k ? at + LANE.EVERY : at) * LANE.TICK_MS + 1_000;
}

const MORNING = onTick("2026-11-26T07:00:00.000Z");
const NOON = onTick("2026-11-26T12:00:00.000Z");
const brand = (id: string, extra: Partial<Tenant> = {}) => ({ id, region: "us", status: "active", timeZone: "Europe/London", ...extra }) as Tenant;
const member = { type: "member", id: "u_admin" } as const;

let db: FakeFirestore;
let w: BoardWorld;
const followUps = () => db.dump("agent_actions").filter((a) => a.action === RAISE_FOLLOWUP_ACTION) as unknown as AgentAction[];
const run = (at: number, tenants: Tenant[] = [brand("ten_a")], deadline = at + LANE.BUDGET_MS) =>
  runRaiseFollowups({ deadlineMs: deadline }, { db, listTenants: async () => tenants, clock: () => at, log: () => {} });

beforeEach(async () => {
  for (const k of ["AUDIENCE_PERSON_LINKS_ENABLED", "AUDIENCE_ONE_VIEW_ENABLED", "ONTOLOGY_PERSON_IDS_ENABLED", "AUDIENCE_FIELDS_ENABLED", "RAISE_PIPELINE_ENABLED", "RAISE_FOLLOWUPS_ENABLED"]) vi.stubEnv(k, "true");
  db = new FakeFirestore();
  w = await boardWorld(db);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the follow-ups lane", () => {
  it("runs on every 30th tick, at offset 13", () => {
    expect(isFollowUpTick(MORNING)).toBe(true);
    expect(isFollowUpTick(MORNING + LANE.TICK_MS)).toBe(false);
    expect(isFollowUpTick(MORNING + LANE.TICK_MS * LANE.EVERY)).toBe(true);
    // Never on a tick the 5, 15 or connectors (7 of 15) lanes use.
    const k = Math.floor(MORNING / LANE.TICK_MS);
    expect(k % 5).not.toBe(0);
    expect(k % 15).not.toBe(7);
  });

  it("does nothing off its tick, or with the switch off", async () => {
    await w.add({ email: "sam@example.com", stage: "contacted", lastTouch: "2026-11-01" });
    const listTenants = vi.fn(async () => [brand("ten_a")]);
    await runRaiseFollowups({ deadlineMs: MORNING + LANE.TICK_MS + 15_000 }, { db, listTenants, clock: () => MORNING + LANE.TICK_MS, log: () => {} });
    vi.stubEnv("RAISE_FOLLOWUPS_ENABLED", "false");
    expect(await runRaiseFollowups({ deadlineMs: MORNING + 15_000 }, { db, listTenants, clock: () => MORNING, log: () => {} })).toEqual({ brands: 0, proposed: 0, acted: 0, cleared: 0, expired: 0 });
    expect(listTenants).not.toHaveBeenCalled();
    expect(followUps()).toEqual([]);
  });

  it("raises follow-ups only 6 to 9 in the brand's morning, once however many runs", async () => {
    await w.add({ email: "sam@example.com", stage: "contacted", lastTouch: "2026-11-01" });
    expect(await run(NOON)).toMatchObject({ brands: 1, proposed: 0 });
    expect(await run(MORNING)).toMatchObject({ brands: 1, proposed: 1 });
    expect(await run(MORNING + LANE.TICK_MS * LANE.EVERY)).toMatchObject({ proposed: 0 });
    expect(followUps()).toHaveLength(1);
    // Morning in Auckland is evening in London.
    const auckland = onTick("2026-11-25T19:00:00.000Z");
    expect(localHour(auckland, "Pacific/Auckland")).toBeGreaterThanOrEqual(8);
    expect(isMorning(auckland, "Pacific/Auckland")).toBe(true);
    expect(isMorning(auckland, "Europe/London")).toBe(false);
    expect(isMorning(MORNING, null)).toBe(true);
  });

  it("puts open follow-ups in step at any hour", async () => {
    const sam = await w.add({ email: "sam@example.com", stage: "contacted", lastTouch: "2026-11-01" });
    await run(MORNING);
    await setFieldValues(w.ctx, { object: "person", recordId: sam, changes: { [w.ids.stage]: w.stage("passed") }, by: member, source: "editor" }, { db });
    expect(await run(NOON)).toMatchObject({ cleared: 1, proposed: 0 });
    expect(followUps()[0]).toMatchObject({ state: "declined", declined: { reason: "stale" } });
  });

  it("skips suspended brands and brands with no board, and stops near its deadline", async () => {
    await w.add({ email: "sam@example.com", stage: "contacted", lastTouch: "2026-11-01" });
    expect(await run(MORNING, [brand("ten_a", { status: "suspended" }), brand("ten_none")])).toMatchObject({ brands: 0, proposed: 0 });
    expect(await run(MORNING, [brand("ten_a")], MORNING + 2_000)).toMatchObject({ brands: 0 });
    expect(followUps()).toEqual([]);
  });

  it("reads brands in their morning first, so a long list still reaches them in their window", async () => {
    await w.add({ email: "sam@example.com", stage: "contacted", lastTouch: "2026-11-01" });
    // Five brands where it is late afternoon, listed before the one in its morning.
    const tokyo = [0, 1, 2, 3, 4].map((i) => brand(`ten_t${i}`, { timeZone: "Asia/Tokyo" }));
    const tenants = [...tokyo, brand("ten_a")];
    expect(runOrder(tenants, MORNING)[0]!.id).toBe("ten_a");
    expect(runOrder(tenants, NOON).map((t) => t.id).sort()).toEqual(tenants.map((t) => t.id).sort());
    // Time enough for one brand only: it is the one in its morning.
    let t = MORNING;
    const clock = () => (t += 100) - 100;
    const r = await runRaiseFollowups({ deadlineMs: MORNING + 3_500 }, { db, listTenants: async () => tenants, clock, log: () => {} });
    expect(r).toMatchObject({ brands: 1, proposed: 1 });
  });

  it("moves the morning group's start a quarter of the way on each run", () => {
    // Eight brands in London, read at 6, 7, 8 and 9 in the morning: four different starts.
    const eight = Array.from({ length: 8 }, (_, i) => brand(`ten_m${i}`));
    const six = onTick("2026-11-26T06:00:00.000Z");
    const runs = [0, 1, 2, 3].map((k) => six + k * LANE.TICK_MS * LANE.EVERY);
    expect(runs.every((at) => isMorning(at, "Europe/London"))).toBe(true);
    const firsts = runs.map((at) => runOrder(eight, at)[0]!.id);
    expect(new Set(firsts).size).toBe(4);
  });

  it("sets open follow-ups aside once the brand has no board, and reads nothing more for a brand never set up", async () => {
    await w.add({ email: "sam@example.com", stage: "contacted", lastTouch: "2026-11-01" });
    expect(await run(MORNING)).toMatchObject({ proposed: 1 });
    await archiveStage(w.ctx, db);
    expect(await run(NOON)).toMatchObject({ brands: 1, cleared: 1 });
    expect(followUps()[0]).toMatchObject({ state: "declined", declined: { reason: "stale" } });
    // Nothing left: the next run counts the brand no more.
    expect(await run(NOON + LANE.TICK_MS * LANE.EVERY)).toMatchObject({ brands: 0, cleared: 0 });
    const before = db.collectionCalls("agent_actions");
    expect(await run(NOON, [brand("ten_none")])).toMatchObject({ brands: 0 });
    expect(db.collectionCalls("agent_actions")).toBe(before);
  });

  it("raises at most 25 new a run", async () => {
    for (let i = 0; i < 27; i++) await w.add({ email: `p${i}@example.com`, stage: "contacted", lastTouch: "2026-11-01" });
    expect(await run(MORNING)).toMatchObject({ proposed: 25 });
    expect(await run(MORNING + LANE.TICK_MS * LANE.EVERY)).toMatchObject({ proposed: 2 });
  });

  it("keeps on with the next brand when one fails", async () => {
    await w.add({ email: "sam@example.com", stage: "contacted", lastTouch: "2026-11-01" });
    const broken = brand("ten_broken", { region: "eu" });
    const r = await runRaiseFollowups(
      { deadlineMs: MORNING + 15_000 },
      { db, regionDb: (region) => (region === "eu" ? ({ collection: () => { throw new Error("down"); } } as never) : db), listTenants: async () => [broken, brand("ten_a")], clock: () => MORNING, log: () => {} },
    );
    expect(r).toMatchObject({ brands: 1, proposed: 1 });
  });
});
