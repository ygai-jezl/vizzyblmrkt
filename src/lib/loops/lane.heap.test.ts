import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addToLoopDay, loopDayId, loopDayTtlAt, runLoopsTransaction, writeBrandPointersTx } from "@/lib/tenant/loops";
import { appendPatternVersionTx } from "@/lib/tenant/patternVersions";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { CounterTree } from "@/lib/types/loopDay";
import type { StyleProfile } from "@/lib/types/styleProfile";
import { loopWeekOf } from "./count";
import { weekBefore } from "./fold";
import { LOOPS } from "./registry";
import { runLoopsLane } from "./tick";

/**
 * The lane's heap at its caps (learning loops steps 4 and 5, section 7 of the plan for steps 4 and
 * 5): a page of brands out of 10,000 projected tenants, a brand with 500 image rows with full
 * prompts and profiles and 150 voted rows, an 88 kind week of counters, and one 7 MiB image being
 * profiled with its base64 string. With LOOPS_ENABLED on too (step 5), every brand on the page
 * also reports 2 closed weeks to the heartbeat, reading 5 folded weeks of 88 kinds each, its usage
 * meter's 60 purposes and its organisation's mark (2 brands to an organisation), and the run
 * holds every credited increment until its one batched write. The heap may grow by less than 64
 * MiB, at its peak while the image is held or a brand reports (for step 5 sampled after a
 * collection, so it counts what the run holds, not garbage waiting to go, and with the memory held
 * outside the heap, where the image's bytes and its base64 string live), and once the run is
 * done. It needs
 * the garbage collector, so it is skipped unless the run has it:
 * NODE_OPTIONS=--expose-gc npx vitest run src/lib/loops/lane.heap.test.ts
 */

const gc = (globalThis as { gc?: () => void }).gc;
const MIB = 1024 * 1024;
const NOW = new Date("2027-03-01T09:00:00.000Z");
const DAY = 86_400_000;
const NATURAL = "image_style.natural_photo";
const PROFILE: StyleProfile = {
  palette: ["#c8a27a", "#3b2a1e", "#f4ead8"],
  lighting: "soft overhead daylight through a shop window",
  composition: "close crop from above, loaves in a loose row",
  mood: "warm and calm, early morning",
  subjectTreatment: "loaves and pastries close up, crumb showing",
  texture: "flour dust on dark wood, linen folds",
  postProcessing: "light warm grade, lifted shadows",
  medium: "photograph",
};

describe.skipIf(typeof gc !== "function")("the loops lane's heap at its caps", () => {
  let db: FakeFirestore;
  const hearth: TenantContext = { tenantId: "ten_00000", region: "us", source: "system" };

  beforeEach(async () => {
    vi.stubEnv("BRAND_STYLE_LOOP_ENABLED", "true");
    vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
    vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "true");
    db = new FakeFirestore();
    for (let i = 0; i < 10_000; i++) {
      db.seed("tenants", `ten_${String(i).padStart(5, "0")}`, { tenantName: `Brand ${i}`, rootDomain: `b${i}.example.com`, status: "active", region: "us", allowedOrigins: [], ownerId: "usr_x", brandVoice: { tone: "x".repeat(2000) } });
    }
    const prompt = "A loaf on dark wood in soft morning light. ".repeat(23).slice(0, 1000);
    for (let i = 0; i < 500; i++) {
      const voted = i < 150;
      db.seed("image_assets", `img_${i}`, {
        tenantId: hearth.tenantId,
        workspaceId: "ws_h",
        filename: `img_${i}.png`,
        mimeType: "image/png",
        kind: "social",
        style: "natural_photo",
        prompt,
        brief: prompt,
        createdAt: new Date(NOW.getTime() - (500 - i) * 3_600_000).toISOString(),
        // One liked image is still to be profiled, so the run holds the 7 MiB image.
        styleProfile: i === 99 ? null : PROFILE,
        ...(voted ? { brandVote: i < 100 ? "up" : "down", brandVoteVia: "vote", firstVotedAt: new Date(NOW.getTime() - (500 - i) * 3_600_000 + DAY).toISOString(), brandRating: 8 } : {}),
      });
    }
    // An 88 kind week of counters.
    const c: CounterTree = {};
    for (let k = 0; k < 88; k++) c[`kind_${k}`] = { v1: { learned: { made: 5, voted: 3, liked: 2 } } };
    const week = loopWeekOf(NOW);
    for (let s = 0; s < 5; s++) await addToLoopDay(hearth, loopDayId.week(hearth.tenantId, week, s), { c: { [NATURAL]: c } }, { ttlAt: loopDayTtlAt("week", week) }, db);
    await runLoopsTransaction(
      hearth,
      async (txn) => {
        appendPatternVersionTx(
          txn,
          hearth,
          { channel: NATURAL, version: 1, directive: null, perform: [], avoid: [], judgeRationale: "", evidence: [], createdBy: "seed", createdAt: "2027-01-01T00:00:00.000Z", loop: "image_style", setBy: "seeded", items: [{ id: "look1", type: "rule", text: "Overhead daylight.", trust: "own_content", from: "seed" }], change: { op: "add", itemId: "look1" } },
          db,
        );
        writeBrandPointersTx(txn, hearth, { scopes: { [NATURAL]: { v: 1, setBy: "seeded", adoptedAt: "2027-01-01T00:00:00.000Z" } }, seededAt: "2027-01-01T00:00:00.000Z" }, db);
      },
      db,
    );
  });
  afterEach(() => vi.unstubAllEnvs());

  /** Step 5's caps: the first page's brands, 2 to an organisation, each 2 weeks behind with 5 folded weeks of 88 kinds. */
  async function seedStep5(): Promise<number> {
    vi.stubEnv("LOOPS_ENABLED", "true");
    vi.stubEnv("USAGE_METER_ENABLED", "true");
    const kinds = Object.keys(LOOPS).filter((k) => !k.startsWith("canvas.")).slice(0, 88);
    const c: CounterTree = {};
    for (const k of kinds) c[k] = { [k]: { v0: { none: { made: 25, kept: 4, edited: 3, declined: 2, "declined.not_for_us": 1 } } } };
    c[NATURAL] = { post_image: { v1: { learned: { made: 22, voted: 9, liked: 5, remade: 1, "disliked.looks_fake": 2, "liked.colours": 1 }, holdback: { made: 2, voted: 1 } } } };
    const u = Object.fromEntries(kinds.map((k) => [k, { records_off: 3, stamp_lost: 1 }]));
    const t = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`type_${i}`, { made: 7 }]));
    const d = { c, u, t, r: { edit_mode: { plan: 4 }, loop_learn: { learned: 1, error: 2 } }, k: { loop_learn: { proposed: 1, acted: 1 } }, o: { image: { voted: 2, liked: 1 } } };
    const last = weekBefore(loopWeekOf(NOW));
    const weeks = [last];
    for (let i = 0; i < 4; i++) weeks.unshift(weekBefore(weeks[0]!));
    const page = 70;
    for (let i = 0; i < page; i++) {
      const id = `ten_${String(i).padStart(5, "0")}`;
      db.seed("tenants", id, { tenantName: `Brand ${i}`, rootDomain: `b${i}.example.com`, status: "active", region: "us", allowedOrigins: [], ownerId: "usr_x", organisationId: `org_${Math.floor(i / 2)}`, orgPlan: "pro" });
      for (const w of weeks) db.seed("loop_days", `lt:${id}:${w}`, { tenantId: id, d });
      db.seed("loop_days", `ls:${id}`, { tenantId: id, d: { foldedThrough: last, heartbeatWeek: weeks[2], meterMonth: NOW.toISOString().slice(0, 7), meterSeen: {} } });
      const calls = Object.fromEntries(Array.from({ length: 60 }, (_, p) => [`purpose_${p}`, 40 + p]));
      db.seed("usage_meters", `um_${id}_${NOW.toISOString().slice(0, 7)}`, { tenantId: id, month: NOW.toISOString().slice(0, 7), meters: { model_tokens: { total: 1, calls: 1, lostCalls: 0, byPurpose: {}, callsByPurpose: calls } }, updatedAt: NOW.toISOString() });
    }
    return page;
  }

  it("grows the heap by less than 64 MiB with LOOPS_ENABLED on too, every brand on the page reporting 2 weeks", async () => {
    const page = await seedStep5();
    // The heap and the memory held outside it, where a Buffer's bytes and a long base64 string live.
    const held = () => {
      const m = process.memoryUsage();
      return m.heapUsed + m.external;
    };
    gc!();
    const before = held();
    let peak = 0;
    // Sampled after a collection: what the run holds at once. Each brand's report also leaves about
    // 1.5 MiB of short lived garbage (its parsed weeks and its mark's copy), which a collection takes.
    const sample = () => {
      gc!();
      peak = Math.max(peak, held() - before);
    };
    const profile = async () => {
      const bytes = Buffer.alloc(7 * MIB, 7);
      const base64 = bytes.toString("base64");
      sample();
      return base64.length > 0 ? PROFILE : null;
    };
    const r = await runLoopsLane(
      { deadlineMs: Date.now() + 120_000 },
      {
        db,
        controlDb: db,
        now: () => NOW,
        anyTick: true,
        memoryLimit: () => null,
        learner: { configured: () => true, profile, synthesize: async () => "Overhead daylight, flour on dark wood.", log: () => undefined },
        // Each brand's report reads its meter: a sample of the heap while the run holds every brand's increments so far.
        usage: async (ctx, month) => {
          sample();
          const { usageThisMonth } = await import("@/lib/plans/meter");
          return usageThisMonth(ctx, { db, month });
        },
      },
    );
    expect(r.brands).toBe(page);
    // A brand whose organisation's mark already moved to the newer week has its older week dropped as late.
    expect(r.reported + r.late).toBe(page * 2);
    expect(r.late).toBeLessThanOrEqual(page / 2);
    expect(r.cells).toBeGreaterThan(100);
    gc!();
    const after = held() - before;
    console.log(`[heap] step 5: peak ${(peak / MIB).toFixed(1)} MiB, after ${(after / MIB).toFixed(1)} MiB, reported ${r.reported}, rows ${r.cells}`);
    expect(peak).toBeLessThan(64 * MIB);
    expect(after).toBeLessThan(64 * MIB);
  });

  it("grows the heap by less than 64 MiB", async () => {
    gc!();
    const before = process.memoryUsage().heapUsed;
    let peak = 0;
    const profile = async () => {
      // The image's bytes and their base64 string, held only for this call.
      const bytes = Buffer.alloc(7 * MIB, 7);
      const base64 = bytes.toString("base64");
      peak = Math.max(peak, process.memoryUsage().heapUsed - before);
      return base64.length > 0 ? PROFILE : null;
    };
    const r = await runLoopsLane(
      { deadlineMs: Date.now() + 120_000 },
      {
        db,
        controlDb: db,
        now: () => NOW,
        anyTick: true,
        memoryLimit: () => null,
        learner: { configured: () => true, profile, synthesize: async () => "Overhead daylight, flour on dark wood.", log: () => undefined },
      },
    );
    expect(r.brands).toBe(70);
    expect(r.rows).toBeGreaterThan(100);
    gc!();
    const after = process.memoryUsage().heapUsed - before;
    console.log(`[heap] peak ${(peak / MIB).toFixed(1)} MiB, after ${(after / MIB).toFixed(1)} MiB, rows ${r.rows}`);
    expect(peak).toBeLessThan(64 * MIB);
    expect(after).toBeLessThan(64 * MIB);
  });
});
