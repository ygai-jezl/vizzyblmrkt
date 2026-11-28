import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOOP_DAYS, loopDayId, loopDayTtlAt } from "@/lib/tenant/loops";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { LoopStamp } from "@/lib/types/loopStamp";
import {
  countCard,
  countDraftOutcome,
  countKindSignals,
  countLearnedSignal,
  countLearnOutcome,
  countLostStamp,
  countMade,
  countMadeKept,
  countRefusedToken,
  countSignal,
  countSignals,
  countsFor,
  countUnstamped,
  draftOutcome,
  isCountedSignal,
  loopWeekOf,
  MADE_AT_ONCE_MAX,
  shardOf,
} from "./count";
import { sumWeek } from "./testing/sumWeek";

/** The Count step (src/lib/loops/count.ts, learning loops step 4, 3.1 of the plan for steps 4 and 5). */

const hearth: TenantContext = { tenantId: "ten_hearth", region: "eu", source: "system" };
const NOW = new Date("2027-01-15T10:00:00.000Z");
const WEEK = "2027-W02";
const NATURAL = "image_style.natural_photo";

const stamp: LoopStamp = {
  made: "m1.image_style.natural_photo.1.l",
  kind: "post_image",
  scope: NATURAL,
  v: 1,
  arm: "learned",
  items: ["look1"],
  prompt: null,
  tokens: { rules: 24, examples: 0 },
  at: "2027-01-14T09:00:00.000Z",
};

function versionsOn() {
  vi.stubEnv("BRAND_STYLE_LOOP_ENABLED", "true");
  vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
  vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "true");
}

/** A database that fails the test on any use. */
const untouchable = new Proxy({}, { get: (_t, p) => { throw new Error(`a count touched the database (${String(p)})`); } }) as FirestoreLike;

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the week and its shards", () => {
  it("names the ISO week a moment falls in, and picks one of the 5 shards", () => {
    expect(loopWeekOf(NOW)).toBe(WEEK);
    expect(loopWeekOf(new Date("2027-01-01T12:00:00.000Z"))).toBe("2026-W53");
    expect([0, 0.2, 0.5, 0.99].map((r) => shardOf(() => r))).toEqual([0, 1, 2, 4]);
    // A random source out of range still lands on a shard.
    expect(shardOf(() => 1)).toBe(0);
    expect(shardOf(() => Number.NaN)).toBe(0);
  });
});

describe("with versions off, or for a kind step 5 turns on", () => {
  it("counts nothing and reads or writes nothing (decision 22)", async () => {
    expect(countsFor("post_image")).toBe(false);
    await countSignals(hearth, stamp, { voted: 1, liked: 1 }, { db: untouchable, now: NOW });
    await countMade(hearth, "post_image", stamp, { db: untouchable, now: NOW, type: "image_asset" });
    await countUnstamped(hearth, "post_image", "own_image", { db: untouchable, now: NOW });
    await countLearnOutcome(hearth, "loop_learn", "learned", { db: untouchable, now: NOW });

    versionsOn();
    expect(countsFor("post_image")).toBe(true);
    expect(countsFor("loop_learn")).toBe(true);
    // Every other kind waits for LOOPS_ENABLED.
    for (const kind of ["blog_write", "edit_mode", "send_time", "canvas.journey"] as const) expect(countsFor(kind), kind).toBe(false);
    await countUnstamped(hearth, "blog_write", "loops_off", { db: untouchable, now: NOW });
    await countCard(hearth, "edit_mode", "proposed", { db: untouchable, now: NOW });
  });
});

describe("several records from one save (the stamp scan, step 5)", () => {
  const templates: LoopStamp = { made: "m1.templates.0.n", kind: "templates", scope: "templates", v: 0, arm: "none", items: [], prompt: null, tokens: { rules: 0, examples: 0 }, at: "2027-01-15T09:00:00.000Z" };

  it("counts each record one save keeps from a call, in one write, up to the cap, and nothing for none", async () => {
    vi.stubEnv("LOOPS_ENABLED", "true");
    const db = new FakeFirestore();
    await countMade(hearth, "templates", templates, { db, now: NOW, type: "template", n: 3, random: () => 0 });
    await countMade(hearth, "templates", templates, { db, now: NOW, type: "template", n: MADE_AT_ONCE_MAX + 50, random: () => 0 });
    for (const n of [0, -2, 1.5]) await countMade(hearth, "templates", templates, { db, now: NOW, type: "template", n, random: () => 0 });
    expect(sumWeek(db, hearth.tenantId, WEEK)).toEqual({
      c: { templates: { templates: { v0: { none: { made: 3 + MADE_AT_ONCE_MAX } } } } },
      t: { template: { made: 3 + MADE_AT_ONCE_MAX } },
    });
  });

  it("counts nothing with LOOPS_ENABLED off (decision 22)", async () => {
    const db = new FakeFirestore();
    await countMade(hearth, "templates", templates, { db, now: NOW, type: "template", n: 3 });
    await countMadeKept(hearth, "brand_kit", { ...templates, made: "m1.brand_kit.0.n", kind: "brand_kit", scope: "brand_kit" }, { db: untouchable, now: NOW });
    expect(sumWeek(db, hearth.tenantId, WEEK)).toEqual({});
  });
});

describe("a thing its own route stores (the brand kit a guidelines PDF is read into)", () => {
  const kit: LoopStamp = { made: "m1.brand_kit.0.n", kind: "brand_kit", scope: "brand_kit", v: 0, arm: "none", items: [], prompt: null, tokens: { rules: 0, examples: 0 }, at: "2027-01-15T09:00:00.000Z" };

  it("counts made and kept at once, in one write, so a kit in force never reads as unused; with no stamp, made with why", async () => {
    vi.stubEnv("LOOPS_ENABLED", "true");
    const db = new FakeFirestore();
    await countMadeKept(hearth, "brand_kit", kit, { db, now: NOW, random: () => 0 });
    expect(db.dump(LOOP_DAYS)).toHaveLength(1);
    await countMadeKept(hearth, "brand_kit", { unstamped: "loops_off" }, { db, now: NOW, random: () => 0 });
    expect(sumWeek(db, hearth.tenantId, WEEK)).toEqual({ c: { brand_kit: { brand_kit: { v0: { none: { made: 1, kept: 1 } } } } }, u: { brand_kit: { loops_off: 1 } } });
  });
});

describe("with versions on", () => {
  beforeEach(versionsOn);

  it("adds a made thing's signals by its stamp, in one shard of the week, with the week's expiry", async () => {
    const db = new FakeFirestore();
    await countSignals(hearth, stamp, { voted: 1, liked: 1 }, { db, now: NOW, random: () => 0.5 });
    const id = loopDayId.week(hearth.tenantId, WEEK, 2);
    expect(db.raw(LOOP_DAYS, id)).toEqual({
      tenantId: "ten_hearth",
      ttlAt: loopDayTtlAt("week", WEEK),
      d: { c: { [NATURAL]: { post_image: { v1: { learned: { voted: 1, liked: 1 } } } } } },
    });
  });

  it("spreads counts over the shards, and they add up to what happened", async () => {
    const db = new FakeFirestore();
    let i = 0;
    const random = () => (i++ % 5) / 5;
    for (let n = 0; n < 12; n++) await countSignal(hearth, stamp, "made", { db, now: NOW, random });
    await countSignals(hearth, stamp, { voted: 3, liked: 2, "liked.colours": 1, "disliked.mood": 1 }, { db, now: NOW, random });
    await countSignals(hearth, stamp, { liked: -1, "liked.colours": -1 }, { db, now: NOW, random });
    expect(db.dump(LOOP_DAYS).length).toBe(5);
    expect(sumWeek(db, hearth.tenantId, WEEK)).toEqual({
      c: { [NATURAL]: { post_image: { v1: { learned: { made: 12, voted: 3, liked: 1, "liked.colours": 0, "disliked.mood": 1 } } } } },
    });
  });

  it("counts a reason only in the direction it belongs to, and only for image votes", async () => {
    expect(isCountedSignal("post_image", "liked.layout")).toBe(true);
    expect(isCountedSignal("post_image", "disliked.fake")).toBe(true);
    // Layout is a reason to like, Looks fake a reason to dislike.
    expect(isCountedSignal("post_image", "disliked.layout")).toBe(false);
    expect(isCountedSignal("post_image", "liked.fake")).toBe(false);
    expect(isCountedSignal("post_image", "liked.whatever")).toBe(false);
    expect(isCountedSignal("blog_write", "liked.colours")).toBe(false);
    expect(isCountedSignal("blog_write", "kept")).toBe(true);

    const db = new FakeFirestore();
    await countSignals(hearth, stamp, { voted: 1, "liked.fake": 1, "disliked.nope": 1, liked: 0.5 } as never, { db, now: NOW, random: () => 0 });
    expect(sumWeek(db, hearth.tenantId, WEEK)).toEqual({ c: { [NATURAL]: { post_image: { v1: { learned: { voted: 1 } } } } } });
    // Nothing left to count writes nothing.
    await countSignals(hearth, stamp, { liked: 0 }, { db: untouchable, now: NOW });
  });

  it("counts made with its type, or why it has no stamp", async () => {
    const db = new FakeFirestore();
    await countMade(hearth, "post_image", stamp, { db, now: NOW, type: "image_asset", random: () => 0 });
    await countMade(hearth, "post_image", { unstamped: "own_image" }, { db, now: NOW, type: "image_asset", random: () => 0 });
    await countUnstamped(hearth, "post_image", "stamp_lost", { db, now: NOW, random: () => 0 });
    await countRefusedToken(hearth, "email_hero", "expired", { db, now: NOW, random: () => 0 });
    // A reason off the closed list is not counted.
    await countUnstamped(hearth, "post_image", "because" as never, { db, now: NOW, random: () => 0 });
    expect(sumWeek(db, hearth.tenantId, WEEK)).toEqual({
      c: { [NATURAL]: { post_image: { v1: { learned: { made: 1 } } } } },
      t: { image_asset: { made: 2 } },
      u: { post_image: { own_image: 1, stamp_lost: 1 }, email_hero: { token_expired: 1 } },
    });
  });

  it("counts a lost stamp under the stamp's own kind, and nothing for a thing with no stamp", async () => {
    const db = new FakeFirestore();
    await countLostStamp(hearth, { ...stamp, kind: "ebook_image" }, { db, now: NOW, random: () => 0 });
    await countLostStamp(hearth, { unstamped: "own_image" }, { db, now: NOW, random: () => 0 });
    await countLostStamp(hearth, null, { db, now: NOW, random: () => 0 });
    expect(sumWeek(db, hearth.tenantId, WEEK)).toEqual({ u: { ebook_image: { stamp_lost: 1 } } });
  });

  it("counts what a learner did and what happened to its cards", async () => {
    const db = new FakeFirestore();
    await countLearnOutcome(hearth, "loop_learn", "learned", { db, now: NOW, random: () => 0 });
    await countLearnOutcome(hearth, "loop_learn", "error", { db, now: NOW, random: () => 0 });
    await countLearnOutcome(hearth, "loop_learn", "giving_up" as never, { db, now: NOW, random: () => 0 });
    await countCard(hearth, "post_image", "proposed", { db, now: NOW, random: () => 0 });
    await countCard(hearth, "post_image", "ignored", { db, now: NOW, random: () => 0 });
    expect(sumWeek(db, hearth.tenantId, WEEK)).toEqual({
      r: { loop_learn: { learned: 1, error: 1 } },
      k: { post_image: { proposed: 1, ignored: 1 } },
    });
  });

  it("never fails the work it counts, and refuses a stamp it can't use", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken = { collection: () => { throw new Error("down"); }, runTransaction: () => { throw new Error("down"); } } as unknown as FirestoreLike;
    await expect(countSignal(hearth, stamp, "liked", { db: broken, now: NOW })).resolves.toBeUndefined();
    await expect(countMade(hearth, "post_image", stamp, { db: broken, now: NOW })).resolves.toBeUndefined();
    await expect(countSignal(hearth, { ...stamp, made: "m1.image_style.brand.1.l" }, "liked", { db: untouchable, now: NOW })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("writes only to this brand's own documents", async () => {
    const db = new FakeFirestore();
    await countSignal({ ...hearth, tenantId: "ten_lumen" }, stamp, "made", { db, now: NOW, random: () => 0 });
    await countSignal(hearth, stamp, "made", { db, now: NOW, random: () => 0 });
    expect(db.dump(LOOP_DAYS).map((d) => d.tenantId).sort()).toEqual(["ten_hearth", "ten_lumen"]);
    expect(sumWeek(db, "ten_lumen", WEEK)).toEqual({ c: { [NATURAL]: { post_image: { v1: { learned: { made: 1 } } } } } });
  });
});

describe("what people did with made things (step 5, 4.4)", () => {
  const post: LoopStamp = { made: "m1.content_write.0.n", kind: "content_write", scope: "content_write", v: 0, arm: "none", items: [], prompt: null, tokens: { rules: 0, examples: 0 }, at: "2027-01-14T09:00:00.000Z" };
  const DRAFT = "Three questions Hearth Bakery asks before a new loaf goes on the shelf.";
  const cell = (signals: Record<string, number>) => ({ c: { content_write: { content_write: { v0: { none: signals } } } } });

  it("tells a draft kept word for word from one edited, and how many words changed", () => {
    expect(draftOutcome(DRAFT, DRAFT)).toEqual({ signal: "kept", wordsChanged: 0 });
    expect(draftOutcome(DRAFT, `${DRAFT}\n`)).toEqual({ signal: "kept", wordsChanged: 0 });
    expect(draftOutcome(DRAFT, DRAFT.replace("new loaf", "seasonal bake"))).toEqual({ signal: "edited", wordsChanged: 2 });
    // No draft kept: nothing to compare.
    expect(draftOutcome(null, DRAFT)).toBeNull();
    expect(draftOutcome("  ", DRAFT)).toBeNull();
  });

  it("counts kept or edited against the stamp; with no draft, no_draft instead (the heartbeat says so); with no stamp, nothing", async () => {
    vi.stubEnv("LOOPS_ENABLED", "true");
    const db = new FakeFirestore();
    const deps = { db, now: NOW, random: () => 0 };
    expect(await countDraftOutcome(hearth, post, { draft: DRAFT, final: DRAFT }, deps)).toEqual({ signal: "kept", wordsChanged: 0 });
    expect(await countDraftOutcome(hearth, post, { draft: DRAFT, final: "Sam rewrote this one." }, deps)).toMatchObject({ signal: "edited" });
    expect(await countDraftOutcome(hearth, post, { wordsChanged: 18 }, deps)).toEqual({ signal: "edited", wordsChanged: 18 });
    expect(await countDraftOutcome(hearth, post, { wordsChanged: 0 }, deps)).toEqual({ signal: "kept", wordsChanged: 0 });
    expect(await countDraftOutcome(hearth, post, { draft: null, final: DRAFT }, deps)).toBeNull();
    expect(await countDraftOutcome(hearth, { unstamped: "person_wrote" }, { draft: DRAFT, final: DRAFT }, deps)).toBeNull();
    expect(await countDraftOutcome(hearth, undefined, { draft: DRAFT, final: DRAFT }, deps)).toBeNull();
    expect(sumWeek(db, hearth.tenantId, WEEK)).toEqual(cell({ kept: 2, edited: 2, no_draft: 1 }));
  });

  it("compares and counts nothing with LOOPS_ENABLED off (decision 22)", async () => {
    expect(await countDraftOutcome(hearth, post, { draft: DRAFT, final: "changed" }, { db: untouchable, now: NOW })).toBeNull();
    await countKindSignals(hearth, "brand_map_research", { declined: 2 }, { db: untouchable, now: NOW });
    await countLearnedSignal(hearth, "post_feedback", "linkedin", 3, "undone", { db: untouchable, now: NOW });
  });

  it("counts the why behind a dismissal as given, a short key only", async () => {
    vi.stubEnv("LOOPS_ENABLED", "true");
    expect(isCountedSignal("canvas.person_fields", "declined.not_for_us")).toBe(true);
    expect(isCountedSignal("canvas.person_fields", "declined.Not For Us")).toBe(false);
    expect(isCountedSignal("canvas.person_fields", `declined.${"x".repeat(30)}`)).toBe(false);
    const db = new FakeFirestore();
    await countSignals(hearth, post, { declined: 1, "declined.not_now": 1, "declined.<b>": 1 } as never, { db, now: NOW, random: () => 0 });
    expect(sumWeek(db, hearth.tenantId, WEEK)).toEqual(cell({ declined: 1, "declined.not_now": 1 }));
  });

  it("counts things whose records keep no stamp in the cell their made count went to, never for an image kind", async () => {
    vi.stubEnv("LOOPS_ENABLED", "true");
    versionsOn();
    const db = new FakeFirestore();
    await countKindSignals(hearth, "brand_map_research", { declined: 3, "liked.colours": 1 }, { db, now: NOW, random: () => 0 });
    await countKindSignals(hearth, "post_image", { declined: 1 }, { db: untouchable, now: NOW });
    await countKindSignals(hearth, "loop_learn", { declined: 1 }, { db: untouchable, now: NOW });
    expect(sumWeek(db, hearth.tenantId, WEEK)).toEqual({ c: { brand_map_research: { brand_map_research: { v0: { none: { declined: 3 } } } } } });
  });

  it("counts a learner's version undone under its own kind and scope, refusing a scope that can't name a counter", async () => {
    vi.stubEnv("LOOPS_ENABLED", "true");
    const db = new FakeFirestore();
    await countLearnedSignal(hearth, "post_feedback", "linkedin", 3, "undone", { db, now: NOW, random: () => 0 });
    await countLearnedSignal(hearth, "post_feedback", "Linked In", 3, "undone", { db: untouchable, now: NOW });
    await countLearnedSignal(hearth, "post_feedback", "linkedin", -1, "undone", { db: untouchable, now: NOW });
    expect(sumWeek(db, hearth.tenantId, WEEK)).toEqual({ c: { linkedin: { post_feedback: { v3: { learned: { undone: 1 } } } } } });
  });
});
