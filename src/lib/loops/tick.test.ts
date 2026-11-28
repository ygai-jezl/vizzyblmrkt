import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLEET_CELLS, fleetCellId } from "@/lib/tenant/fleetCells";
import { LANE_DOC_ID, LOOP_LANE, readLoopLane } from "@/lib/tenant/loopLane";
import { LOOP_DAYS, readBrandPointers, readLaneState, runLoopsTransaction, writeBrandPointersTx } from "@/lib/tenant/loops";
import { getPatternVersion } from "@/lib/tenant/patternVersions";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { setHelpCheck, setImageLearningPaused } from "./actions";
import { countCard, countKindSignals, loopWeekOf } from "./count";
import { weekBefore } from "./fold";
import { cardsAsNotice, containerMemoryLimit, isLoopsTick, memoryTooHigh, pageSizeFor, runLoopsLane, signalHash, visitHash } from "./tick";
import { loopsData } from "./loopsSection";

/** The loops lane (learning loops step 4, 4.5): its page through the brands, the idle check, the guard and the seed. */

const NOW = new Date("2026-12-16T09:00:00.000Z");
const MIB = 1024 * 1024;
let db: FakeFirestore;

beforeEach(() => {
  db = new FakeFirestore();
  vi.stubEnv("BRAND_STYLE_LOOP_ENABLED", "true");
  vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
  vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "true");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function brand(id: string, extra: Record<string, unknown> = {}) {
  db.seed("tenants", id, { tenantName: id, rootDomain: `${id}.example.com`, status: "active", region: "us", allowedOrigins: [], ownerId: "usr_x", ...extra });
}

const lane = (over: Parameters<typeof runLoopsLane>[1] = {}) =>
  runLoopsLane(
    { deadlineMs: Date.now() + 60_000 },
    { db, controlDb: db, now: () => NOW, anyTick: true, memory: () => ({ rss: 200 * MIB, heapUsed: 50 * MIB }), memoryLimit: () => null, ...over },
  );

describe("the page", () => {
  it("visits every brand about once a day: 3 runs over 12 brands with K of 5 make 15 visits and reach all 12", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `ten_${String(i + 1).padStart(2, "0")}`);
    for (const id of ids) brand(id);
    const visited: string[] = [];
    for (let run = 0; run < 3; run++) visited.push(...(await lane()).visited);
    expect(visited).toHaveLength(15);
    expect(new Set(visited)).toEqual(new Set(ids));
    // The third run reached the end and started again from the first.
    expect(visited.slice(10)).toEqual(["ten_11", "ten_12", "ten_01", "ten_02", "ten_03"]);
    expect((await readLoopLane(db)).cursor).toBe("ten_03");
  });

  it("follows the number of brands, between 5 and 100", () => {
    expect(pageSizeFor(0)).toBe(5);
    expect(pageSizeFor(12)).toBe(5);
    expect(pageSizeFor(1_440)).toBe(10);
    expect(pageSizeFor(14_400)).toBe(100);
    expect(pageSizeFor(1_000_000)).toBe(100);
  });

  it("leaves suspended brands out", async () => {
    brand("ten_a");
    brand("ten_b", { status: "suspended" });
    expect((await lane()).visited).toEqual(["ten_a"]);
  });
});

describe("a brand's visit", () => {
  it("seeds a brand on its first visit, folds, and moves the lane on; the next visit with nothing new is one batched read", async () => {
    brand("ten_hearth", { brandKit: { learnedImageStyle: "Warm natural light, rustic wood and linen." } });
    const first = await lane();
    expect(first).toMatchObject({ brands: 1, idle: 0 });
    const pointers = await readBrandPointers({ tenantId: "ten_hearth", region: "us", source: "system" }, db);
    expect(pointers.seededAt).toBe(NOW.toISOString());
    expect((await getPatternVersion({ tenantId: "ten_hearth", region: "us", source: "system" }, "image_style.brand", 1, db))?.setBy).toBe("seeded");
    const state = await readLaneState({ tenantId: "ten_hearth", region: "us", source: "system" }, db);
    expect(state.foldedThrough).toBeDefined();
    expect(state.seen?.hash).toBe(visitHash([], pointers));
    expect(state.quietUntil! > NOW.toISOString()).toBe(true);

    const opened = () => ({ loopDays: db.collectionCalls(LOOP_DAYS), images: db.collectionCalls("image_assets"), versions: db.collectionCalls("learned_pattern_versions") });
    const before = opened();
    const second = await lane();
    expect(second).toMatchObject({ brands: 1, idle: 1, rows: 0 });
    const after = opened();
    // lb:, ls: and the open week's 5 shards, and nothing else.
    expect(after.loopDays - before.loopDays).toBe(7);
    expect(after.images - before.images).toBe(0);
    expect(after.versions - before.versions).toBe(0);
  });

  it("visits a brand fully again after a person's Pause or Resume, which write only its pointers", async () => {
    brand("ten_hearth");
    const ctx = { tenantId: "ten_hearth", region: "us" as const, source: "system" as const };
    await lane();
    expect(await setImageLearningPaused(ctx, true, { db, now: NOW })).toEqual({ ok: true });
    // Paused: a full visit, then quiet for days, as nothing is due by time.
    expect(await lane()).toMatchObject({ brands: 1, idle: 0 });
    expect(await lane()).toMatchObject({ brands: 1, idle: 1 });
    // Resume: the likes that came in during the pause are learned from on the next visit, not a week on.
    expect(await setImageLearningPaused(ctx, false, { db, now: NOW })).toEqual({ ok: true });
    expect(await lane()).toMatchObject({ brands: 1, idle: 0 });
  });

  it("skips the learner when the open Go back cards can't be read, and visits fully again next time", async () => {
    brand("ten_hearth");
    const ctx = { tenantId: "ten_hearth", region: "us" as const, source: "system" as const };
    await lane({
      openCards: async () => {
        throw new Error("read failed");
      },
    });
    const state = await readLaneState(ctx, db);
    // The learner never ran, so it kept no mark, and nothing waits by time: the next visit is full.
    expect(state.learnRead).toBeUndefined();
    expect(state.quietUntil).toBe(NOW.toISOString());
    expect(await lane()).toMatchObject({ brands: 1, idle: 0 });
    expect((await readLaneState(ctx, db)).learnRead).toBeDefined();
  });

  it("sends a worse read to the card's own notice on a copy without Review, and under the attention rule", async () => {
    const ctx = { tenantId: "ten_hearth", region: "us" as const, source: "system" as const };
    expect(await cardsAsNotice(ctx, {}, { now: NOW, db })).toBe(true);
    vi.stubEnv("NEXT_PUBLIC_NAV_V2_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_NAV_V2_PHASE2_ENABLED", "true");
    expect(await cardsAsNotice(ctx, {}, { now: NOW, db })).toBe(false);
    for (let i = 0; i < 3; i++) await countCard(ctx, "loop_learn", "ignored", { db, now: NOW });
    expect(await cardsAsNotice(ctx, {}, { now: NOW, db })).toBe(true);
  });

  it("clears a forgotten look's old copy on the brand record until it is gone", async () => {
    const at = "2026-12-10T09:00:00.000Z";
    brand("ten_hearth", {
      imageStyle: { defaultStyleId: "natural_photo", learned: { natural_photo: { directive: "Overhead daylight.", sampleCount: 3, updatedAt: "2026-12-01T09:00:00.000Z" } } },
    });
    const ctx = { tenantId: "ten_hearth", region: "us" as const, source: "system" as const };
    await runLoopsTransaction(ctx, async (txn) => writeBrandPointersTx(txn, ctx, { scopes: {}, seededAt: at, forgot: { "image_style.natural_photo": { at } } }, db), db);
    await lane();
    expect((db.raw("tenants", "ten_hearth") as { imageStyle: { learned: Record<string, unknown> } }).imageStyle.learned.natural_photo).toBeUndefined();
  });
});

describe("the guards", () => {
  it("runs only with image style versions on, on its own ticks", async () => {
    brand("ten_a");
    expect(isLoopsTick(1 * 120_000)).toBe(true);
    expect(isLoopsTick(5 * 120_000)).toBe(false);
    expect(isLoopsTick(7 * 120_000)).toBe(false);
    expect((await lane({ anyTick: false, now: () => new Date(5 * 120_000) })).skipped).toBe("tick");
    vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "");
    expect(await lane()).toMatchObject({ skipped: "switch", brands: 0 });
    expect(db.dump(LOOP_DAYS)).toEqual([]);
  });

  it("skips its run when the instance holds too much memory", async () => {
    brand("ten_a");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect((await lane({ memory: () => ({ rss: 700 * MIB, heapUsed: 0 }) })).skipped).toBe("memory");
    expect((await lane({ memory: () => ({ rss: 400 * MIB, heapUsed: 0 }), memoryLimit: () => 512 * MIB })).skipped).toBe("memory");
    expect(log).toHaveBeenCalledWith("[loops] skipped: memory");
    expect(memoryTooHigh(300 * MIB, 1024 * MIB)).toBe(false);
    expect(containerMemoryLimit(() => "max\n")).toBeNull();
    expect(containerMemoryLimit(() => "1073741824\n")).toBe(1024 * MIB);
    expect(containerMemoryLimit(() => {
      throw new Error("no cgroup");
    })).toBeNull();
    expect(db.dump(LOOP_DAYS)).toEqual([]);
  });

  it("hashes what people did, not the lane's own counts, whichever shard it landed in", () => {
    const people = { c: { "image_style.natural_photo": { post_image: { v1: { learned: { liked: 1 } } } } } };
    expect(signalHash([people, undefined])).toBe(signalHash([undefined, people]));
    expect(signalHash([{ ...people, r: { loop_learn: { error: 3 } } }])).toBe(signalHash([people]));
    expect(signalHash([{ o: { image: { liked: 1 } } }])).not.toBe(signalHash([]));
    // The pointers count too, whatever order their keys are in.
    const p = { scopes: { "image_style.natural_photo": { v: 1, setBy: "learned" as const, adoptedAt: "2026-12-01T09:00:00.000Z" } }, seededAt: "2026-12-01T09:00:00.000Z" };
    expect(visitHash([people], p)).toBe(visitHash([people], { seededAt: p.seededAt, scopes: p.scopes }));
    expect(visitHash([people], { ...p, pause: { image_style: { at: "2026-12-02T09:00:00.000Z" } } })).not.toBe(visitHash([people], p));
  });
});

describe("the lane widened (LOOPS_ENABLED, step 5)", () => {
  const W = weekBefore(loopWeekOf(NOW));
  const IN_W = new Date("2026-12-09T10:00:00.000Z");
  const ctxOf = (tenantId: string) => ({ tenantId, region: "us" as const, source: "system" as const });
  const made = (tenantId: string, n: number) => countKindSignals(ctxOf(tenantId), "next_up", { made: n }, { db, now: IN_W });
  const row = (id: string) => (db.raw(FLEET_CELLS, id) as { n: Record<string, unknown> } | undefined)?.n;

  /** The loops came on well before W: every week from then on is reported. */
  const ON_FROM = "2026-W40";

  beforeEach(() => {
    vi.stubEnv("LOOPS_ENABLED", "true");
    db.seed(LOOP_LANE, LANE_DOC_ID, { d: { cursor: null, loopsOnFrom: ON_FROM } });
  });

  it("keeps the week the loops came on in, reports and lists no week before it, and forgets it while they are off", async () => {
    db.cols.get(LOOP_LANE)?.delete(LANE_DOC_ID);
    brand("ten_hearth", { organisationId: "org_hearth" });
    await made("ten_hearth", 3);
    // Just turned on in the open week: W was counted with the loops off, so nothing of it is sent.
    expect(await lane()).toMatchObject({ brands: 1, reported: 0, cells: 0 });
    expect((await readLoopLane(db)).loopsOnFrom).toBe(loopWeekOf(NOW));
    expect((await readLoopLane(db)).listedWeek).toBeUndefined();
    expect(db.dump(FLEET_CELLS)).toEqual([]);
    expect(await readLaneState(ctxOf("ten_hearth"), db)).toMatchObject({ heartbeatWeek: W, reportsFromWeek: loopWeekOf(NOW) });
    // The next run keeps the week it was turned on in; the brand has nothing left to report.
    expect(await lane()).toMatchObject({ reported: 0 });
    expect((await readLoopLane(db)).loopsOnFrom).toBe(loopWeekOf(NOW));
    // Off with image style versions on: the lane still runs, and forgets the week.
    vi.stubEnv("LOOPS_ENABLED", "");
    await lane();
    expect((await readLoopLane(db)).loopsOnFrom).toBeUndefined();
  });

  /** The runs every 10 minutes in between, left out: the lane's document says the last was just before `at`. */
  const ranJustBefore = (at: Date) => {
    const cur = db.raw(LOOP_LANE, LANE_DOC_ID) as { d: Record<string, unknown> };
    db.seed(LOOP_LANE, LANE_DOC_ID, { d: { ...cur.d, at: new Date(at.getTime() - 10 * 60_000).toISOString() } });
  };
  const runAt = (at: Date) => lane({ now: () => at });
  const orgsOf = (week: string) => row(fleetCellId.orgs(week));

  it("starts the loops' week again after both switches were off for weeks, when nothing ran the lane", async () => {
    db.cols.get(LOOP_LANE)?.delete(LANE_DOC_ID);
    brand("ten_hearth", { organisationId: "org_hearth" });
    await runAt(new Date("2026-11-30T09:00:00.000Z"));
    expect((await readLoopLane(db)).loopsOnFrom).toBe("2026-W49");
    // Both off: the lane doesn't run, so nothing takes the week away.
    vi.stubEnv("LOOPS_ENABLED", "");
    vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "");
    expect((await runAt(new Date("2026-12-14T09:00:00.000Z"))).skipped).toBe("switch");
    expect((await readLoopLane(db)).loopsOnFrom).toBe("2026-W49");
    // Back on five weeks later: no week from the time off is reported or listed.
    vi.stubEnv("LOOPS_ENABLED", "true");
    const back = new Date("2027-01-04T09:00:00.000Z");
    expect(await runAt(back)).toMatchObject({ brands: 1, reported: 0, cells: 0 });
    expect((await readLoopLane(db)).loopsOnFrom).toBe(loopWeekOf(back));
    for (const w of ["2026-W49", "2026-W50", "2026-W51", "2026-W52", "2026-W53"]) expect(orgsOf(w), w).toBeUndefined();
    expect((await readLaneState(ctxOf("ten_hearth"), db)).reportsFromWeek).toBe(loopWeekOf(back));
  });

  it("with only LOOPS_ENABLED on, reports no week from the time it was off once it is back", async () => {
    vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "");
    db.cols.get(LOOP_LANE)?.delete(LANE_DOC_ID);
    brand("ten_hearth", { organisationId: "org_hearth" });
    const t1 = new Date("2026-11-10T10:00:00.000Z");
    await runAt(t1);
    expect((await readLoopLane(db)).loopsOnFrom).toBe("2026-W46");
    // Hearth makes 12 picks in 2026-W46, reported the next week by a lane that ran all along.
    await countKindSignals(ctxOf("ten_hearth"), "next_up", { made: 12 }, { db, now: t1 });
    const t2 = new Date("2026-11-17T10:00:00.000Z");
    ranJustBefore(t2);
    expect(await runAt(t2)).toMatchObject({ reported: 1 });
    expect(row(fleetCellId.kind("next_up", "2026-W46"))).toMatchObject({ out: { none: { made: 12 } } });
    // Off for three weeks: with image style versions off too, the lane doesn't run.
    vi.stubEnv("LOOPS_ENABLED", "");
    expect((await runAt(new Date("2026-11-25T10:00:00.000Z"))).skipped).toBe("switch");
    // Back on in 2026-W50, and an hour later: nothing from 2026-W47 to W49 goes out, nor unused from W46.
    vi.stubEnv("LOOPS_ENABLED", "true");
    const t3 = new Date("2026-12-09T10:00:00.000Z");
    expect(await runAt(t3)).toMatchObject({ reported: 0 });
    expect((await readLoopLane(db)).loopsOnFrom).toBe("2026-W50");
    expect(await runAt(new Date(t3.getTime() + 3_600_000))).toMatchObject({ reported: 0 });
    for (const w of ["2026-W47", "2026-W48", "2026-W49"]) {
      expect(orgsOf(w), w).toBeUndefined();
      expect(row(fleetCellId.kind("next_up", w)), w).toBeUndefined();
    }
    expect(await readLaneState(ctxOf("ten_hearth"), db)).toMatchObject({ heartbeatWeek: "2026-W49", reportsFromWeek: "2026-W50" });
  });

  it("keeps the loops' week across runs a few minutes apart", async () => {
    db.cols.get(LOOP_LANE)?.delete(LANE_DOC_ID);
    const t = new Date("2026-11-30T09:00:00.000Z");
    await runAt(t);
    await runAt(new Date(t.getTime() + 10 * 60_000));
    expect((await readLoopLane(db)).loopsOnFrom).toBe("2026-W49");
    // The next week, with the runs in between: still the week they came on in.
    const later = new Date("2026-12-08T09:00:00.000Z");
    ranJustBefore(later);
    await runAt(later);
    expect((await readLoopLane(db)).loopsOnFrom).toBe("2026-W49");
  });

  it("runs with only LOOPS_ENABLED on: it folds and reports each brand's closed week, and never seeds or reads image rows", async () => {
    vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "");
    expect(loopWeekOf(IN_W)).toBe(W);
    brand("ten_hearth", { organisationId: "org_hearth" });
    await made("ten_hearth", 3);
    const first = await lane();
    expect(first).toMatchObject({ brands: 1, idle: 0, reported: 1, late: 0 });
    expect(first.cells).toBeGreaterThan(0);
    expect(row(fleetCellId.kind("next_up", W))).toMatchObject({ orgs: 1, out: { none: { made: 3 } }, st: { stamped: { p: { open: 1 }, i: { unknown: 1 } } } });
    expect(row(fleetCellId.orgs(W))).toMatchObject({ orgs: 1, reported: 1, listed: 1 });
    expect((await readBrandPointers(ctxOf("ten_hearth"), db)).seededAt).toBeUndefined();
    expect(db.collectionCalls("image_assets")).toBe(0);
    // Reported and folded: the next visit is one batched read of lb: and ls:.
    const opened = db.collectionCalls(LOOP_DAYS);
    expect(await lane()).toMatchObject({ brands: 1, idle: 1, reported: 0 });
    expect(db.collectionCalls(LOOP_DAYS) - opened).toBe(2);
  });

  it("counts an organisation with two brands once, caps its outputs at 20, and never counts twice on a rerun", async () => {
    brand("ten_lumen_eu", { organisationId: "org_lumen" });
    brand("ten_lumen_us", { organisationId: "org_lumen" });
    await made("ten_lumen_eu", 15);
    await made("ten_lumen_us", 15);
    expect(await lane()).toMatchObject({ brands: 2, reported: 2 });
    const before = row(fleetCellId.kind("next_up", W));
    expect(before).toMatchObject({ orgs: 1, out: { none: { made: 20 } }, st: { stamped: { p: { open: 1 } } } });
    expect(row(fleetCellId.orgs(W))).toMatchObject({ orgs: 1, reported: 2 });
    expect(await lane()).toMatchObject({ brands: 2, reported: 0 });
    expect(row(fleetCellId.kind("next_up", W))).toEqual(before);
    // One mark for the organisation, beside the lane's own document.
    expect(db.dump(LOOP_LANE)).toHaveLength(2);
  });

  it("drops a report older than its organisation's mark and counts it as late, and adds only what the mark hasn't credited", async () => {
    const w1 = weekBefore(W);
    brand("ten_lumen_eu", { organisationId: "org_lumen" });
    db.seed(LOOP_LANE, "o:org_lumen", { d: { week: W, cells: ["_orgs/orgs"], outputs: {} } });
    db.seed(LOOP_DAYS, "ls:ten_lumen_eu", { tenantId: "ten_lumen_eu", d: { foldedThrough: weekBefore(w1), heartbeatWeek: weekBefore(w1) } });
    expect(await lane()).toMatchObject({ brands: 1, reported: 1, late: 1 });
    // Visited for that week too: a late report is still a visit.
    expect(row(fleetCellId.orgs(w1))).toEqual({ late: 1, visited: 1 });
    const now = row(fleetCellId.orgs(W))!;
    expect(now.orgs).toBeUndefined();
    expect(now).toMatchObject({ p: { open: 1 }, reported: 1 });
  });

  it("leaves a brand that opted out out of every count across brands, and keeps its own learning", async () => {
    brand("ten_hearth");
    await made("ten_hearth", 4);
    await runLoopsTransaction(ctxOf("ten_hearth"), async (txn) => writeBrandPointersTx(txn, ctxOf("ten_hearth"), { scopes: {}, fleetOptOut: { at: "2026-12-01T09:00:00.000Z" } }, db), db);
    expect(await lane()).toMatchObject({ brands: 1, reported: 0 });
    expect(row(fleetCellId.kind("next_up", W))).toBeUndefined();
    expect(db.dump(LOOP_LANE)).toHaveLength(1);
    expect((await readLaneState(ctxOf("ten_hearth"), db)).heartbeatWeek).toBe(W);
    // Its own week is still folded.
    expect(db.raw(LOOP_DAYS, `lt:ten_hearth:${W}`)).toBeDefined();
  });

  it("with only LOOPS_ENABLED on, leaves a brand whose admin turned the learning setting off out of every count across brands", async () => {
    vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "");
    brand("ten_hearth", { organisationId: "org_hearth" });
    brand("ten_lumen", { organisationId: "org_lumen" });
    await made("ten_hearth", 4);
    await made("ten_lumen", 3);
    // The action the learning setting's route calls while image style versions are off.
    expect(await setHelpCheck(ctxOf("ten_hearth"), false, { db, now: IN_W })).toEqual({ ok: true, offSince: IN_W.toISOString() });
    expect(await lane()).toMatchObject({ brands: 2, reported: 1 });
    // Only Lumen's things are counted, and only Lumen's organisation has a mark.
    expect(row(fleetCellId.kind("next_up", W))).toMatchObject({ orgs: 1, out: { none: { made: 3 } } });
    expect(row(fleetCellId.orgs(W))).toMatchObject({ orgs: 1, reported: 1, visited: 2, listed: 2 });
    expect(db.raw(LOOP_LANE, "o:org_hearth")).toBeUndefined();
    expect(db.raw(LOOP_LANE, "o:org_lumen")).toBeDefined();
    // Hearth's weeks are done, its own week is still folded, and nothing of its images is touched.
    expect((await readLaneState(ctxOf("ten_hearth"), db)).heartbeatWeek).toBe(W);
    expect(db.raw(LOOP_DAYS, `lt:ten_hearth:${W}`)).toBeDefined();
    expect((await readBrandPointers(ctxOf("ten_hearth"), db)).seededAt).toBeUndefined();
    expect(db.collectionCalls("image_assets")).toBe(0);
  });

  it("compares brands visited, opted out ones included, with brands listed, suspended ones left out, so coverage isn't behind for good", async () => {
    brand("ten_a");
    await made("ten_a", 3);
    brand("ten_b");
    await runLoopsTransaction(ctxOf("ten_b"), async (txn) => writeBrandPointersTx(txn, ctxOf("ten_b"), { scopes: {}, fleetOptOut: { at: "2026-12-01T09:00:00.000Z" } }, db), db);
    brand("ten_c", { status: "suspended" });
    await lane();
    await lane();
    await lane();
    const orgs = row(fleetCellId.orgs(W))!;
    expect(orgs).toMatchObject({ orgs: 1, reported: 1, visited: 2, listed: 2 });
    const d = loopsData({ week: W, orgs, rows: new Map() }, { meterOn: false, today: NOW, docsUrl: "" });
    expect(d.behind).toBe(false);
    expect(d.coverage[0]).toEqual({ k: "Brands visited", v: "2 of 2 this week", amber: false });
  });

  it("counts each closed week's brands listed once, however many runs it takes", async () => {
    brand("ten_a");
    brand("ten_b");
    await lane();
    await lane();
    expect(row(fleetCellId.orgs(W))).toMatchObject({ listed: 2, reported: 2 });
    expect((await readLoopLane(db)).listedWeek).toBe(W);
  });

  it("counts a brand whose fold fell more than 42 days behind once a week, and logs it", async () => {
    let behind = W;
    for (let i = 0; i < 8; i++) behind = weekBefore(behind);
    brand("ten_hearth");
    db.seed(LOOP_DAYS, "ls:ten_hearth", { tenantId: "ten_hearth", d: { foldedThrough: behind, heartbeatWeek: W } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await lane();
    expect(warn).toHaveBeenCalledWith("[loops] fold behind 51");
    expect(row(fleetCellId.orgs(W))).toMatchObject({ foldBehind: { w8: 1 } });
    expect((await readLaneState(ctxOf("ten_hearth"), db)).behindWeek).toBe(W);
  });

  it("changes nothing with LOOPS_ENABLED off: no heartbeat, no marks and no counts across brands", async () => {
    vi.stubEnv("LOOPS_ENABLED", "");
    brand("ten_hearth", { organisationId: "org_hearth" });
    const r = await lane();
    expect(r).toMatchObject({ brands: 1, reported: 0, cells: 0 });
    expect(db.dump(FLEET_CELLS)).toEqual([]);
    expect(db.dump(LOOP_LANE)).toHaveLength(1);
    expect((await readLoopLane(db)).listedWeek).toBeUndefined();
    expect((await readLoopLane(db)).loopsOnFrom).toBeUndefined();
    expect((await readLaneState(ctxOf("ten_hearth"), db)).heartbeatWeek).toBeUndefined();
  });
});
