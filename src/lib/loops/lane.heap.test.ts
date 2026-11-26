import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addToLoopDay, loopDayId, loopDayTtlAt, runLoopsTransaction, writeBrandPointersTx } from "@/lib/tenant/loops";
import { appendPatternVersionTx } from "@/lib/tenant/patternVersions";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { CounterTree } from "@/lib/types/loopDay";
import type { StyleProfile } from "@/lib/types/styleProfile";
import { loopWeekOf } from "./count";
import { runLoopsLane } from "./tick";

/**
 * The lane's heap at its caps (learning loops step 4, section 7 of the plan for steps 4 and 5):
 * a page of brands out of 10,000 projected tenants, a brand with 500 image rows with full prompts
 * and profiles and 150 voted rows, an 88 kind week of counters, and one 7 MiB image being
 * profiled with its base64 string. The heap may grow by less than 64 MiB, at its peak while the
 * image is held and once the run is done. It needs the garbage collector, so it is skipped unless
 * the run has it: NODE_OPTIONS=--expose-gc npx vitest run src/lib/loops/lane.heap.test.ts
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
