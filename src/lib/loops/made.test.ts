import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { LoopStamp } from "@/lib/types/loopStamp";
import { CountBuffer, countsFor } from "./count";
import { keptMade, nodeStampsAfter, rootOf, withRoot } from "./made";
import { learnedFor } from "./read";
import { RunCache } from "./runCache";
import { sumWeek } from "./testing/sumWeek";

/**
 * Step 5's writers (learning loops step 5, 4.1 and 4.2 of the plan for steps 4 and 5): what a
 * record keeps in `made`, a node's two stamps, every other kind's stamp with LOOPS_ENABLED on,
 * and a batch run's stamps and counts. Hearth Bakery and Lumen are made up.
 */

const hearth: TenantContext = { tenantId: "ten_hearth", region: "eu", source: "system" };
const lumen: TenantContext = { tenantId: "ten_lumen", region: "us", source: "system" };
const NOW = new Date("2027-01-15T10:00:00.000Z");
const WEEK = "2027-W02";

/** A database that fails the test on any use. */
const untouchable = new Proxy({}, { get: (_t, p) => { throw new Error(`touched the database (${String(p)})`); } }) as FirestoreLike;

const words: LoopStamp = { made: "m1.content_write.0.n", kind: "content_write", scope: "content_write", v: 0, arm: "none", items: [], prompt: null, tokens: { rules: 0, examples: 0 }, at: NOW.toISOString() };
const image: LoopStamp = { ...words, made: "m1.image_style.natural_photo.1.l", kind: "post_image", scope: "image_style.natural_photo", v: 1, arm: "learned", items: ["look1"] };

afterEach(() => vi.unstubAllEnvs());

describe("with LOOPS_ENABLED off", () => {
  it("keeps nothing, stamps every other kind loops_off with no read, and counts nothing (decision 22)", async () => {
    expect(keptMade(words)).toBeUndefined();
    expect(keptMade({ unstamped: "person_wrote" })).toBeUndefined();
    expect(nodeStampsAfter({}, words, { body: true, image: false })).toEqual({});
    expect(nodeStampsAfter({ made: words }, { unstamped: "person_restored" }, { body: true, image: false })).toEqual({ made: words });
    expect(await learnedFor(hearth, "content_write", { promptId: "content.fill" }, { db: untouchable })).toEqual({
      block: { look: null, holdback: false },
      stamp: { unstamped: "loops_off" },
    });
    expect(countsFor("send_time")).toBe(false);
    const counts = new CountBuffer({ db: untouchable });
    counts.made(hearth, "send_time", words);
    expect(counts.size).toBe(0);
    await counts.flush();
  });
});

describe("with LOOPS_ENABLED on", () => {
  beforeEach(() => vi.stubEnv("LOOPS_ENABLED", "true"));

  it("stamps every kind that isn't an image kind arm none at version 0 in its own scope, with no read", async () => {
    for (const kind of ["content_write", "lifecycle_lines", "next_up", "edit_mode", "canvas.invite_wave"] as const) {
      const { block, stamp } = await learnedFor(hearth, kind, { by: "vizzy" }, { db: untouchable, now: NOW });
      expect(block).toEqual({ look: null, holdback: false });
      expect(stamp).toMatchObject({ made: `m1.${kind}.0.n`, kind, scope: kind, v: 0, arm: "none", items: [], by: "vizzy", at: NOW.toISOString() });
    }
    // The stamp names no brand and no person.
    const { stamp } = await learnedFor(hearth, "content_write", { promptId: "content.fill" }, { db: untouchable });
    expect(JSON.stringify(stamp)).not.toContain("hearth");
    expect(stamp).toMatchObject({ prompt: expect.stringMatching(/^content\.fill@\d+#[0-9a-f]{6}$/) });
  });

  it("keeps a stamp or a reason, never a switch's reason", () => {
    expect(keptMade(words)).toEqual(words);
    expect(keptMade({ unstamped: "own_image" })).toEqual({ unstamped: "own_image" });
    expect(keptMade({ unstamped: "loops_off" })).toBeUndefined();
    expect(keptMade({ unstamped: "image_versions_off" })).toBeUndefined();
    expect(keptMade(null)).toBeUndefined();
  });

  it("gives a node's words and image a stamp each, and only for what the write changed", () => {
    // Words written: the words' stamp. A new image: the image's. Neither takes the other away.
    const one = nodeStampsAfter({}, words, { body: true, image: false });
    expect(one).toEqual({ made: words });
    const two = nodeStampsAfter(one, image, { body: false, image: true });
    expect(two).toEqual({ made: words, imageMade: image });
    // A brief (words stamp, no body) or a schedule changes nothing.
    expect(nodeStampsAfter(two, { ...words, kind: "content_brief", scope: "content_brief", made: "m1.content_brief.0.n" }, { body: false, image: false })).toEqual(two);
    for (const r of ["dates_only", "records_where", "person_marked_checked"] as const) {
      expect(nodeStampsAfter(two, { unstamped: r }, { body: true, image: true })).toEqual(two);
    }
    // A person's own image and words, an image taken away, and words with nothing made.
    expect(nodeStampsAfter(two, { unstamped: "own_image" }, { body: false, image: true })).toEqual({ made: words, imageMade: { unstamped: "own_image" } });
    expect(nodeStampsAfter(two, { unstamped: "removes_image" }, { body: false, image: true })).toEqual({ made: words });
    expect(nodeStampsAfter(two, { unstamped: "person_restored" }, { body: true, image: false })).toEqual({ made: { unstamped: "person_restored" }, imageMade: image });
    expect(nodeStampsAfter(two, { unstamped: "nothing_made" }, { body: true, image: false })).toEqual({ imageMade: image });
  });

  it("names a stamp's root, the first made thing upstream", () => {
    expect(rootOf(words)).toBe("m1.content_write.0.n");
    expect(rootOf({ ...words, root: "m1.lifecycle_lines.0.n" })).toBe("m1.lifecycle_lines.0.n");
    expect(rootOf({ unstamped: "person_wrote" })).toBeUndefined();
    expect(withRoot(words, "m1.lifecycle_lines.0.n")).toEqual({ ...words, root: "m1.lifecycle_lines.0.n" });
    expect(withRoot({ unstamped: "person_wrote" }, "m1.lifecycle_lines.0.n")).toEqual({ unstamped: "person_wrote" });
    expect(withRoot(words, undefined)).toBe(words);
  });
});

describe("a batch run's stamps and counts", () => {
  beforeEach(() => vi.stubEnv("LOOPS_ENABLED", "true"));

  it("reads a kind's stamp once per brand in a run, and never for an image", async () => {
    const run = new RunCache({ now: NOW });
    const a = await run.stamp(hearth, "send_time");
    const b = await run.stamp(hearth, "send_time");
    expect(b).toBe(a);
    expect(await run.stamp(lumen, "send_time")).not.toBe(a);
    expect(() => run.stamp(hearth, "post_image")).toThrow(/not for image kinds/);
  });

  it("adds a run's counts up and writes each brand's once, when the run ends", async () => {
    const db = new FakeFirestore();
    const writes = vi.spyOn(db, "collection");
    const counts = new CountBuffer({ db, now: NOW, random: () => 0 });
    const stamp = (await learnedFor(hearth, "send_time", {}, { now: NOW })).stamp;
    for (let i = 0; i < 40; i++) counts.made(hearth, "send_time", stamp, { type: "email_send" });
    counts.unstamped(hearth, "send_time", "stamp_lost");
    counts.made(lumen, "send_time", stamp);
    expect(writes).not.toHaveBeenCalled();
    expect(counts.size).toBe(2);
    await counts.flush();
    expect(counts.size).toBe(0);
    // One write per brand, however many emails it sent.
    expect(writes).toHaveBeenCalledTimes(2);
    expect(sumWeek(db, hearth.tenantId, WEEK)).toEqual({
      c: { send_time: { send_time: { v0: { none: { made: 40 } } } } },
      t: { email_send: { made: 40 } },
      u: { send_time: { stamp_lost: 1 } },
    });
    expect(sumWeek(db, lumen.tenantId, WEEK)).toEqual({ c: { send_time: { send_time: { v0: { none: { made: 1 } } } } } });
    // A second flush writes nothing.
    await counts.flush();
    expect(writes).toHaveBeenCalledTimes(2);
  });

  it("never fails the run when its counts can't be written", async () => {
    const broken = { collection: () => { throw new Error("down"); } } as unknown as FirestoreLike;
    const counts = new CountBuffer({ db: broken, now: NOW });
    counts.made(hearth, "send_time", (await learnedFor(hearth, "send_time")).stamp);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(counts.flush()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
