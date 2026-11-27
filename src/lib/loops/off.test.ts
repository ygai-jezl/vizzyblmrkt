import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLEET_CELLS } from "@/lib/tenant/fleetCells";
import { LANE_DOC_ID, LOOP_LANE, readLoopLane } from "@/lib/tenant/loopLane";
import { LOOP_DAYS, readLaneState } from "@/lib/tenant/loops";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { AgentAction } from "@/lib/types/agentAction";
import type { LoopStamp } from "@/lib/types/loopStamp";
import {
  CountBuffer,
  countCard,
  countDraftOutcome,
  countKindSignals,
  countLearnedSignal,
  countLearnOutcome,
  countMade,
  countRefusedToken,
  countSignals,
  countsFor,
  countUnstamped,
} from "./count";
import { countAgentDecision, countStamped } from "./decisions";
import { handBack, stampsFromTokens, withStampToken } from "./handBack";
import { isImageKind } from "./imageKinds";
import { learnedFor, notLearningStamp } from "./read";
import { LOOPS, type LoopKind } from "./registry";
import { RunCache } from "./runCache";
import { runLoopsLane } from "./tick";
import { usedAcrossBrands } from "./used";

/**
 * LOOPS_ENABLED off is today exactly (learning loops step 5, decision 22 of the plan for steps 4
 * and 5), in one place: every way step 5 stamps, counts and reports runs here with the switch off,
 * and nothing reads or writes `loop_days`, `loop_lane` or `fleet_cells` beyond what step 4 already
 * did. With every switch off, as the copy ships, nothing touches the database at all; with image
 * style versions on, the lane is step 4's lane. The senders' own off cases sit beside them
 * (src/lib/lifecycle/runner.test.ts, src/lib/nextUp/pick.test.ts,
 * src/lib/distribute/scheduler.counts.test.ts and src/lib/loops/writers.test.ts). Hearth Bakery
 * is made up.
 */

const hearth: TenantContext = { tenantId: "ten_hearth", region: "us", source: "system" };
const NOW = new Date("2026-12-16T09:00:00.000Z");
/** A moment in the last closed week, which a heartbeat would report with the loops on. */
const IN_CLOSED_WEEK = new Date("2026-12-09T10:00:00.000Z");
const MIB = 1024 * 1024;

/** A database that fails the test on any use. */
const untouchable = new Proxy({}, { get: (_t, p) => { throw new Error(`touched the database (${String(p)})`); } }) as FirestoreLike;

/** Every kind LOOPS_ENABLED stamps and counts: all but the image kinds and the image learner, which follow image style versions alone. */
const LOOPS_KINDS = (Object.keys(LOOPS) as LoopKind[]).filter((k) => !isImageKind(k) && k !== "loop_learn");

function versionsOn() {
  vi.stubEnv("BRAND_STYLE_LOOP_ENABLED", "true");
  vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
  vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "true");
}

/** Each kind's stamp as it was made while the loops were on: a record made then still holds it. */
async function stampsMadeWhileOn(): Promise<Array<[LoopKind, LoopStamp]>> {
  vi.stubEnv("LOOPS_ENABLED", "true");
  const out: Array<[LoopKind, LoopStamp]> = [];
  for (const kind of LOOPS_KINDS) {
    const { stamp } = await learnedFor(hearth, kind, {}, { db: untouchable, now: IN_CLOSED_WEEK });
    if ("unstamped" in stamp) throw new Error(`${kind} made no stamp with LOOPS_ENABLED on`);
    out.push([kind, stamp]);
  }
  vi.stubEnv("LOOPS_ENABLED", "");
  return out;
}

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe.each([
  ["every other switch off", false],
  ["image style versions on", true],
])("with LOOPS_ENABLED off and %s", (_name, versions) => {
  beforeEach(() => {
    if (versions) versionsOn();
  });

  it("stamps every kind it would count loops_off, with no read", async () => {
    expect(LOOPS_KINDS.length).toBeGreaterThan(10);
    for (const kind of LOOPS_KINDS) {
      expect(await learnedFor(hearth, kind, { by: "vizzy" }, { db: untouchable }), kind).toEqual({ block: { look: null, holdback: false }, stamp: { unstamped: "loops_off" } });
      expect(notLearningStamp(kind), kind).toEqual({ unstamped: "loops_off" });
      expect(await new RunCache({ db: untouchable }).stamp(hearth, kind), kind).toEqual({ unstamped: "loops_off" });
      expect(countsFor(kind), kind).toBe(false);
    }
  });

  it("counts nothing for any of them, even against a stamp kept while the loops were on", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const deps = { db: untouchable, now: IN_CLOSED_WEEK };
    const buffer = new CountBuffer(deps);
    for (const [kind, stamp] of await stampsMadeWhileOn()) {
      await countSignals(hearth, stamp, { made: 1, kept: 1, edited: 1, declined: 1, undone: 1 }, deps);
      await countMade(hearth, kind, stamp, { ...deps, type: "template", n: 3 });
      await countMade(hearth, kind, { unstamped: "loops_off" }, deps);
      await countUnstamped(hearth, kind, "loops_off", deps);
      await countUnstamped(hearth, kind, "stamp_lost", deps);
      await countRefusedToken(hearth, kind, "expired", deps);
      await countKindSignals(hearth, kind, { made: 2, kept: 1 }, deps);
      await countCard(hearth, kind, "proposed", deps);
      await countLearnOutcome(hearth, kind, "learned", deps);
      await countLearnedSignal(hearth, kind, "post_feedback.linkedin", 1, "reversed", deps);
      expect(await countDraftOutcome(hearth, stamp, { draft: "Fresh sourdough at 8.", final: "Fresh rye at 8." }, deps), kind).toBeNull();
      expect(await countDraftOutcome(hearth, stamp, { wordsChanged: 2 }, deps), kind).toBeNull();
      await countStamped(hearth, stamp, { kept: 1 }, deps);
      await countAgentDecision(hearth, { state: "proposed", made: stamp } as unknown as AgentAction, { state: "undone", made: stamp } as unknown as AgentAction, deps);
      buffer.made(hearth, kind, stamp, { type: "email_send" });
      buffer.made(hearth, kind, { unstamped: "loops_off" });
      buffer.unstamped(hearth, kind, "stamp_lost");
      // A hand-off signs no token and counts nothing, and a save given tokens checks none.
      expect(await handBack(hearth, kind, stamp, deps), kind).toBeNull();
      expect(await stampsFromTokens(hearth, [kind], ["a.token.from.before"], deps), kind).toEqual([]);
    }
    expect(buffer.size).toBe(0);
    await buffer.flush();
    // So every answer that hands one back is today's answer.
    expect(withStampToken({ ok: true }, null)).toEqual({ ok: true });
  });

  it("reads nothing across brands: Work's Used counts answer off", async () => {
    for (const ask of [{ loopKind: "next_up" as const }, { type: "template" }, { purpose: "content.fill" }]) {
      expect(await usedAcrossBrands(ask, ["2026-W49", "2026-W50"], { db: untouchable })).toEqual({ off: "loops_off" });
    }
  });
});

describe("the loops lane with LOOPS_ENABLED off", () => {
  const brand = (db: FakeFirestore, id: string, extra: Record<string, unknown> = {}) =>
    db.seed("tenants", id, { tenantName: id, rootDomain: `${id}.example.com`, status: "active", region: "us", allowedOrigins: [], ownerId: "usr_x", ...extra });
  const lane = (db: FirestoreLike, over: Parameters<typeof runLoopsLane>[1] = {}) =>
    runLoopsLane(
      { deadlineMs: Date.now() + 60_000 },
      { db, controlDb: db, now: () => NOW, anyTick: true, memory: () => ({ rss: 200 * MIB, heapUsed: 50 * MIB }), memoryLimit: () => null, ...over },
    );

  it("doesn't run with every switch off: no read and no write", async () => {
    expect(await lane(untouchable)).toMatchObject({ skipped: "switch", brands: 0, reported: 0, cells: 0 });
  });

  it("runs only step 4's lane with image style versions on: no heartbeat, no marks, no counts across brands and no meter read", async () => {
    versionsOn();
    const db = new FakeFirestore();
    brand(db, "ten_hearth", { organisationId: "org_hearth" });
    // A closed week the heartbeat would report, counted while the loops were on.
    vi.stubEnv("LOOPS_ENABLED", "true");
    await countKindSignals(hearth, "next_up", { made: 3 }, { db, now: IN_CLOSED_WEEK });
    vi.stubEnv("LOOPS_ENABLED", "");
    const usage = vi.fn(async () => ({}));

    expect(await lane(db, { usage })).toMatchObject({ brands: 1, idle: 0, reported: 0, late: 0, cells: 0 });
    const before = db.collectionCalls(LOOP_DAYS);
    expect(await lane(db, { usage })).toMatchObject({ brands: 1, idle: 1, reported: 0, late: 0, cells: 0 });
    // The idle visit reads what step 4's does: lb:, ls: and the open week's 5 shards, and nothing else in loop_days.
    expect(db.collectionCalls(LOOP_DAYS) - before).toBe(7);

    expect(usage).not.toHaveBeenCalled();
    expect(db.collectionCalls(FLEET_CELLS)).toBe(0);
    expect(db.collectionCalls("usage_meters")).toBe(0);
    // loop_lane keeps only the lane's own document, as in step 4: no organisation's mark and no week listed.
    expect([...(db.cols.get(LOOP_LANE)?.keys() ?? [])]).toEqual([LANE_DOC_ID]);
    expect((await readLoopLane(db)).listedWeek).toBeUndefined();
    const state = await readLaneState(hearth, db);
    expect(state).not.toHaveProperty("heartbeatWeek");
    expect(state).not.toHaveProperty("behindWeek");
    expect(state).not.toHaveProperty("meterSeen");
  });
});
