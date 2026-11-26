import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLoopsTransaction, writeBrandPointersTx } from "@/lib/tenant/loops";
import { appendPatternVersion } from "@/lib/tenant/patternVersions";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { BrandPointers } from "@/lib/types/loopDay";
import type { LoopStamp } from "@/lib/types/loopStamp";
import { BRAND_SCOPE, IMAGE_KINDS, imageScopeOf, isHeldBack, learnedFor, notLearningStamp } from "./read";
import { IMAGE_STYLE_SCOPES, LOOP_RULES, LOOPS, type LoopKind } from "./registry";
import { promptStamp } from "./stamp";

/**
 * The one reader (src/lib/loops/read.ts, learning loops step 4, 3.3 of the plan for steps 4 and
 * 5). Hearth Bakery's looks: Natural photo learned from votes, the brand look carried over.
 */

const hearth: TenantContext = { tenantId: "ten_hearth", region: "us", source: "idtoken" };
const NOW = new Date("2027-01-15T10:00:00.000Z");
const NATURAL = "image_style.natural_photo";
const STILL_LIFE = "image_style.product_still_life";
const NATURAL_LOOK = "Overhead daylight, flour dusted on dark wood, loaves close up, warm and soft, no people.";
const BRAND_LOOK = "Warm natural light, rustic wood and linen, honest close ups of bread.";

function versionsOn() {
  vi.stubEnv("BRAND_STYLE_LOOP_ENABLED", "true");
  vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
  vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "true");
}

/** A database that fails the test on any use. */
const untouchable = new Proxy({}, { get: (_t, p) => { throw new Error(`the reader touched the database (${String(p)})`); } }) as FirestoreLike;

async function version(db: FakeFirestore, scope: string, v: number, text: string | null, setBy: "learned" | "seeded" | "person" = "learned") {
  await appendPatternVersion(
    hearth,
    {
      channel: scope,
      version: v,
      directive: null,
      perform: [],
      avoid: [],
      judgeRationale: "",
      evidence: [],
      createdBy: setBy === "seeded" ? "seed" : setBy === "person" ? "person" : "auto",
      createdAt: NOW.toISOString(),
      loop: "image_style",
      setBy,
      items: text ? [{ id: `look${v}`, type: "rule", text, trust: setBy === "person" ? "person" : "own_content", from: setBy === "person" ? "person" : setBy === "seeded" ? "seed" : "votes" }] : [],
    },
    db,
  );
}

async function pointTo(db: FakeFirestore, pointers: BrandPointers) {
  await runLoopsTransaction(hearth, async (txn) => writeBrandPointersTx(txn, hearth, pointers, db), db);
}

const at = "2027-01-14T09:00:00.000Z";

/** Hearth on 15 Jan: Natural photo learned version 1, the brand look carried over as version 1, Product still life nothing yet. */
async function hearthOn15Jan(over: Partial<BrandPointers> = {}, natural: Partial<BrandPointers["scopes"][string]> = {}) {
  const db = new FakeFirestore();
  await version(db, NATURAL, 1, NATURAL_LOOK);
  await version(db, BRAND_SCOPE, 1, BRAND_LOOK, "seeded");
  await pointTo(db, {
    scopes: { [NATURAL]: { v: 1, setBy: "learned", adoptedAt: at, ...natural }, [BRAND_SCOPE]: { v: 1, setBy: "seeded", adoptedAt: "2026-12-02T09:00:00.000Z" } },
    seededAt: "2026-12-02T09:00:00.000Z",
    ...over,
  });
  return db;
}

/** An image id the hash holds back, and one it doesn't, for a scope. */
function idsFor(scope: string): { held: string; kept: string } {
  let held: string | null = null;
  let kept: string | null = null;
  for (let i = 0; !held || !kept; i++) {
    const id = `img-${i}`;
    if (isHeldBack(scope, id)) held ??= id;
    else kept ??= id;
  }
  return { held, kept };
}

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllEnvs());

describe("which kinds and scopes", () => {
  it("counts every kind that learns the image look as an image kind, and Customise and carousels too", () => {
    const pooled = (Object.keys(LOOPS) as LoopKind[]).filter((k) => {
      const line = LOOPS[k];
      return "loop" in line && line.loop.pool === "image_style";
    });
    expect(pooled.length).toBe(5);
    for (const k of pooled) expect(IMAGE_KINDS).toContain(k);
    expect(IMAGE_KINDS).toContain("customize_image");
    expect(IMAGE_KINDS).toContain("carousel");
  });

  it("maps an image's style to its scope: old ids to the style they became, no style to the brand look", () => {
    expect(imageScopeOf("natural_photo")).toBe(NATURAL);
    expect(imageScopeOf("photographic")).toBe(NATURAL);
    expect(imageScopeOf("cinematic")).toBe("image_style.editorial_photo");
    expect(imageScopeOf(null)).toBe(BRAND_SCOPE);
    expect(imageScopeOf("cyberpunk")).toBe(BRAND_SCOPE);
    expect(imageScopeOf("headline_card")).toBe("image_style.headline_card");
    expect(IMAGE_STYLE_SCOPES).not.toContain(imageScopeOf("headline_card"));
  });
});

describe("with the switches off (decision 22)", () => {
  it("gives an image kind today's look and image_versions_off, with no read", async () => {
    for (const legacy of [undefined, null, BRAND_LOOK]) {
      expect(await learnedFor(hearth, "post_image", { scope: NATURAL, outputId: "img-1", legacy }, { db: untouchable })).toEqual({
        block: { look: legacy, holdback: false },
        stamp: { unstamped: "image_versions_off" },
      });
    }
    vi.stubEnv("BRAND_STYLE_LOOP_ENABLED", "true");
    vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
    expect((await learnedFor(hearth, "blog_hero", { legacy: BRAND_LOOK }, { db: untouchable })).stamp).toEqual({ unstamped: "image_versions_off" });
  });

  it("gives every other kind an empty block and loops_off, with no read, even with image versions on", async () => {
    versionsOn();
    for (const kind of ["content_write", "lifecycle_lines", "next_up", "edit_mode"] as const) {
      expect(await learnedFor(hearth, kind, {}, { db: untouchable })).toEqual({ block: { look: null, holdback: false }, stamp: { unstamped: "loops_off" } });
    }
  });
});

describe("notLearningStamp", () => {
  it("stamps an image made on a path that never learns arm none at version 0, with no read; off, as learnedFor says", () => {
    const now = new Date("2027-01-15T10:00:00.000Z");
    expect(notLearningStamp("post_image", { scope: "image_style.headline_card" }, { now })).toEqual({ unstamped: "image_versions_off" });
    expect(notLearningStamp("content_write")).toEqual({ unstamped: "loops_off" });
    versionsOn();
    expect(notLearningStamp("ebook_image", { scope: "image_style.data_story", promptId: "content.ebook_image_brief" }, { now })).toMatchObject({
      made: "m1.image_style.data_story.0.n",
      kind: "ebook_image",
      scope: "image_style.data_story",
      v: 0,
      arm: "none",
      items: [],
      prompt: expect.stringMatching(/^content\.ebook_image_brief@\d+#[0-9a-f]{6}$/),
      at: now.toISOString(),
    });
    expect(notLearningStamp("post_image")).toMatchObject({ scope: BRAND_SCOPE, arm: "none" });
  });
});

describe("with image style versions on", () => {
  beforeEach(versionsOn);

  it("uses Natural photo's learned look in two round trips: lb:, then both looks in use at once", async () => {
    const db = await hearthOn15Jan();
    const opened = () => [db.collectionCalls("loop_days"), db.collectionCalls("learned_pattern_versions")];
    const [days, versions] = opened();
    const { kept } = idsFor(NATURAL);
    const got = await learnedFor(hearth, "post_image", { scope: NATURAL, outputId: kept, promptId: "content.style_profile_synthesize" }, { db, now: NOW });
    expect(got.block).toEqual({ look: NATURAL_LOOK, holdback: false });
    expect(got.stamp).toEqual({
      made: "m1.image_style.natural_photo.1.l",
      kind: "post_image",
      scope: NATURAL,
      v: 1,
      arm: "learned",
      items: ["look1"],
      prompt: promptStamp("content.style_profile_synthesize"),
      tokens: { rules: Math.ceil(NATURAL_LOOK.length / 4), examples: 0 },
      at: NOW.toISOString(),
    });
    expect(opened()).toEqual([days! + 1, versions! + 2]);
  });

  it("gives a style with no look of its own the brand look, stamped as the brand look", async () => {
    const db = await hearthOn15Jan();
    const { kept } = idsFor(BRAND_SCOPE);
    const got = await learnedFor(hearth, "ebook_image", { scope: STILL_LIFE, outputId: kept }, { db, now: NOW });
    expect(got.block.look).toBe(BRAND_LOOK);
    expect(got.stamp).toMatchObject({ made: "m1.image_style.brand.1.l", scope: BRAND_SCOPE, v: 1, arm: "learned", items: ["look1"] });
  });

  it("gives the brand look to a style whose version holds no words, as after an Undo of its first look", async () => {
    const db = await hearthOn15Jan();
    await version(db, NATURAL, 2, null, "person");
    await pointTo(db, {
      scopes: { [NATURAL]: { v: 2, setBy: "person", adoptedAt: at }, [BRAND_SCOPE]: { v: 1, setBy: "seeded", adoptedAt: at } },
      seededAt: at,
    });
    const { kept } = idsFor(BRAND_SCOPE);
    const got = await learnedFor(hearth, "post_image", { scope: NATURAL, outputId: kept }, { db, now: NOW });
    expect(got.block.look).toBe(BRAND_LOOK);
    expect((got.stamp as LoopStamp).scope).toBe(BRAND_SCOPE);
  });

  it("uses no look, arm none, when neither the style nor the brand has one", async () => {
    const db = new FakeFirestore();
    await pointTo(db, { scopes: {}, seededAt: at });
    const got = await learnedFor(hearth, "post_image", { scope: STILL_LIFE, outputId: "img-1" }, { db, now: NOW });
    expect(got.block).toEqual({ look: null, holdback: false });
    expect(got.stamp).toMatchObject({ made: "m1.image_style.product_still_life.0.n", arm: "none", items: [], tokens: { rules: 0, examples: 0 } });
  });

  it("holds back about 1 image in 20 per scope, by the image's id", () => {
    for (const scope of [NATURAL, BRAND_SCOPE]) {
      let held = 0;
      for (let i = 0; i < 10_000; i++) if (isHeldBack(scope, randomUUID())) held++;
      expect(held / 10_000, scope).toBeGreaterThan(0.04);
      expect(held / 10_000, scope).toBeLessThan(0.06);
    }
    const id = randomUUID();
    expect(isHeldBack(NATURAL, id)).toBe(isHeldBack(NATURAL, id));
    expect(LOOP_RULES.holdbackOneIn).toBe(20);
  });

  it("leaves a held back image without the learned look or the references picked from votes", async () => {
    const db = await hearthOn15Jan();
    const { held } = idsFor(NATURAL);
    const got = await learnedFor(hearth, "post_image", { scope: NATURAL, outputId: held }, { db, now: NOW });
    expect(got.block).toEqual({ look: null, holdback: true });
    expect(got.stamp).toMatchObject({ made: "m1.image_style.natural_photo.1.h", arm: "holdback", v: 1, items: [], tokens: { rules: 0, examples: 0 } });
  });

  it("holds back a look carried over, as it does one learned", async () => {
    const db = await hearthOn15Jan();
    const { held } = idsFor(BRAND_SCOPE);
    const got = await learnedFor(hearth, "blog_hero", { outputId: held }, { db, now: NOW });
    expect(got.stamp).toMatchObject({ scope: BRAND_SCOPE, arm: "holdback" });
  });

  it("never holds back a look a person set or kept, for a brand that opted out, or with no image id", async () => {
    const { held } = idsFor(NATURAL);
    const cases: Array<[string, Promise<FakeFirestore>]> = [
      ["set by a person", hearthOn15Jan({}, { setBy: "person" })],
      ["kept", hearthOn15Jan({}, { keptAt: at })],
      ["opted out", hearthOn15Jan({ fleetOptOut: { at } })],
    ];
    for (const [name, made] of cases) {
      const got = await learnedFor(hearth, "post_image", { scope: NATURAL, outputId: held }, { db: await made, now: NOW });
      expect(got.block, name).toEqual({ look: NATURAL_LOOK, holdback: false });
      expect((got.stamp as LoopStamp).arm, name).toBe("learned");
    }
    const noId = await learnedFor(hearth, "post_image", { scope: NATURAL }, { db: await hearthOn15Jan(), now: NOW });
    expect((noId.stamp as LoopStamp).arm).toBe("learned");
  });

  it("still uses the look in use while image learning is paused, with its usual arm", async () => {
    const db = await hearthOn15Jan({ pause: { image_style: { at } } });
    const { kept, held } = idsFor(NATURAL);
    expect((await learnedFor(hearth, "post_image", { scope: NATURAL, outputId: kept }, { db, now: NOW })).block.look).toBe(NATURAL_LOOK);
    expect((await learnedFor(hearth, "post_image", { scope: NATURAL, outputId: held }, { db, now: NOW })).stamp).toMatchObject({ arm: "holdback" });
  });

  it("leaves the look out with Use learned brand style unticked: arm none, person_off, the version in use recorded", async () => {
    const { held } = idsFor(NATURAL);
    const got = await learnedFor(hearth, "post_image", { scope: NATURAL, outputId: held, useBrandStyle: false, legacy: BRAND_LOOK }, { db: await hearthOn15Jan(), now: NOW });
    expect(got.block).toEqual({ look: null, holdback: false });
    expect(got.stamp).toMatchObject({ made: "m1.image_style.natural_photo.1.n", arm: "none", v: 1, sources: ["person_off"], items: [] });
  });

  it("uses the old field before the brand is seeded: arm none, legacy, as today", async () => {
    const db = new FakeFirestore();
    for (const legacy of [undefined, NATURAL_LOOK]) {
      const got = await learnedFor(hearth, "post_image", { scope: NATURAL, outputId: "img-1", legacy }, { db, now: NOW });
      expect(got.block).toEqual({ look: legacy, holdback: false });
      expect(got.stamp).toMatchObject({ made: "m1.image_style.natural_photo.0.n", arm: "none", v: 0, sources: ["legacy"] });
    }
  });

  it("uses the old field, stamped legacy, when its own read fails, so the image is still made", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = new Proxy({}, { get: () => () => { throw new Error("unavailable"); } }) as FirestoreLike;
    const got = await learnedFor(hearth, "post_image", { scope: NATURAL, outputId: "img-1", legacy: NATURAL_LOOK }, { db: broken, now: NOW });
    expect(got.block.look).toBe(NATURAL_LOOK);
    expect(got.stamp).toMatchObject({ arm: "none", sources: ["legacy"] });
    const off = await learnedFor(hearth, "post_image", { scope: NATURAL, outputId: "img-1", useBrandStyle: false, legacy: null }, { db: broken, now: NOW });
    expect(off).toEqual({ block: { look: null, holdback: false }, stamp: expect.objectContaining({ arm: "none", v: 0, sources: ["person_off"] }) });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("reads nothing for a kind that doesn't learn or a drawn style: no look, arm none", async () => {
    expect(await learnedFor(hearth, "customize_image", { outputId: "img-1" }, { db: untouchable, now: NOW })).toEqual({
      block: { look: null, holdback: false },
      stamp: expect.objectContaining({ made: "m1.image_style.brand.0.n", kind: "customize_image", arm: "none", v: 0 }),
    });
    const drawn = await learnedFor(hearth, "post_image", { scope: imageScopeOf("headline_card"), outputId: "img-1" }, { db: untouchable, now: NOW });
    expect(drawn.stamp).toMatchObject({ made: "m1.image_style.headline_card.0.n", arm: "none" });
    expect((await learnedFor(hearth, "carousel", {}, { db: untouchable, now: NOW })).stamp).toMatchObject({ kind: "carousel", arm: "none" });
  });

  it("names the agent and the thing upstream when given, and never another brand's look", async () => {
    const db = await hearthOn15Jan();
    const { kept } = idsFor(NATURAL);
    const got = await learnedFor(hearth, "blog_hero", { scope: NATURAL, outputId: kept, by: "vizzy", root: "m1.content_write.linkedin.2.l" }, { db, now: NOW });
    expect(got.stamp).toMatchObject({ by: "vizzy", root: "m1.content_write.linkedin.2.l" });
    // Lumen points at the same scope and version, and finds no words of its own: Hearth's rows stay Hearth's.
    const lumen: TenantContext = { tenantId: "ten_lumen", region: "us", source: "idtoken" };
    await runLoopsTransaction(lumen, async (txn) => writeBrandPointersTx(txn, lumen, { scopes: { [NATURAL]: { v: 1, setBy: "learned", adoptedAt: at } }, seededAt: at }, db), db);
    const theirs = await learnedFor(lumen, "post_image", { scope: NATURAL, outputId: kept }, { db, now: NOW });
    expect(theirs.block).toEqual({ look: null, holdback: false });
    expect(theirs.stamp).toMatchObject({ arm: "none", scope: NATURAL, v: 1 });
  });
});
