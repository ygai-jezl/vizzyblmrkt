import { describe, expect, it } from "vitest";
import { ImageAssetSchema } from "./imageAsset";
import { LearnedPatternVersionSchema } from "./learnedPatternVersion";
import { LoopStampSchema, MadeIdSchema, MadeSchema, STAMP_MAX_BYTES, UNSTAMPED_REASONS, type LoopStamp } from "./loopStamp";

const stamp = (over: Partial<LoopStamp> = {}): LoopStamp => ({
  made: "m1.image_style.natural_photo.1.l",
  kind: "post_image",
  scope: "image_style.natural_photo",
  v: 1,
  arm: "learned",
  items: ["look"],
  prompt: "content.image@3#a1b2c3",
  tokens: { rules: 40, examples: 0 },
  at: "2026-11-26T09:00:00.000Z",
  ...over,
});

describe("the stamp", () => {
  it("keeps a scope, a version and an arm, and its made id names the same three", () => {
    expect(LoopStampSchema.parse(stamp())).toEqual(stamp());
    expect(LoopStampSchema.safeParse(stamp({ made: "m1.image_style.natural_photo.2.l" })).success).toBe(false);
    expect(LoopStampSchema.safeParse(stamp({ made: "m1.image_style.natural_photo.1.h" })).success).toBe(false);
    expect(LoopStampSchema.safeParse(stamp({ made: "m1.image_style.brand.1.l" })).success).toBe(false);
    expect(LoopStampSchema.safeParse(stamp({ arm: "holdback", made: "m1.image_style.natural_photo.1.h" })).success).toBe(true);
    expect(LoopStampSchema.safeParse(stamp({ arm: "none", v: 0, made: "m1.image_style.natural_photo.0.n.k3x9q2" })).success).toBe(true);
  });

  it("refuses a made id that isn't one: wrong start, an upper case or spaced scope, a long tail, or 64 characters", () => {
    for (const bad of ["m2.image_style.brand.1.l", "image_style.brand.1.l", "m1.Image_Style.brand.1.l", "m1.image style.1.l", "m1.image_style.brand.1.x", "m1.image_style.brand.1.l.toolongtail", `m1.${"a".repeat(57)}.1.l`]) {
      expect(MadeIdSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("names a kind the learning registry has, an agent YouGrow has, and sources from the closed list", () => {
    expect(LoopStampSchema.safeParse(stamp({ kind: "not_a_kind" as never })).success).toBe(false);
    expect(LoopStampSchema.safeParse(stamp({ by: "vizzy" })).success).toBe(true);
    expect(LoopStampSchema.safeParse(stamp({ by: "someone" as never })).success).toBe(false);
    expect(LoopStampSchema.safeParse(stamp({ sources: ["refs:3", "best_of:2", "legacy", "person_off", "fallback_drawn"].slice(0, 4) })).success).toBe(true);
    expect(LoopStampSchema.safeParse(stamp({ sources: ["learned:6"] })).success).toBe(false);
    expect(LoopStampSchema.safeParse(stamp({ sources: ["legacy", "legacy", "legacy", "legacy", "legacy"] })).success).toBe(false);
  });

  it(`stays at ${STAMP_MAX_BYTES} bytes or less`, () => {
    const full = stamp({
      made: "m1.image_style.product_still_life.999999.h.abc123",
      scope: "image_style.product_still_life",
      v: 999_999,
      arm: "holdback",
      kind: "email_block_image",
      items: ["i1", "i2", "i3", "i4", "i5", "i6", "i7", "i8"],
      prompt: "p".repeat(80),
      tokens: { rules: 99_999, examples: 99_999 },
      sources: ["refs:3", "best_of:4", "person_off", "legacy"],
      by: "connector_signals",
      root: "m1.content_write.linkedin.12.l.zz99aa",
    });
    expect(LoopStampSchema.safeParse(full).success).toBe(true);
    expect(LoopStampSchema.safeParse({ ...full, items: full.items.map((i) => i.padEnd(16, "x")) }).success).toBe(false);
    expect(LoopStampSchema.safeParse(stamp({ prompt: "p".repeat(81) })).success).toBe(false);
    expect(LoopStampSchema.safeParse(stamp({ items: Array.from({ length: 9 }, (_, i) => `i${i}`) })).success).toBe(false);
  });

  it("or says why there is none, from a closed list", () => {
    expect(MadeSchema.parse({ unstamped: "image_versions_off" })).toEqual({ unstamped: "image_versions_off" });
    expect(MadeSchema.safeParse({ unstamped: "forgot" }).success).toBe(false);
    expect(new Set(UNSTAMPED_REASONS).size).toBe(UNSTAMPED_REASONS.length);
    for (const r of UNSTAMPED_REASONS) expect(r).toMatch(/^[a-z]+(?:_[a-z]+)*$/);
  });
});

describe("the fields step 4 adds to records", () => {
  const asset = {
    id: "img1",
    tenantId: "ten_hearth",
    workspaceId: "ws1",
    filename: "a.png",
    mimeType: "image/png",
    kind: "social" as const,
    createdAt: "2026-11-26T09:00:00.000Z",
  };

  it("keeps an image's stamp, remake, first vote and the why behind its vote, instead of stripping them", () => {
    const row = {
      ...asset,
      made: stamp(),
      remadeAt: "2026-11-27T09:00:00.000Z",
      remadeBy: "img2",
      brandVote: "down" as const,
      brandVoteVia: "vote" as const,
      firstVotedAt: "2026-11-26T10:00:00.000Z",
      brandVoteReason: "mood" as const,
      brandVoteNote: "Too dark for a bakery window",
      brandVoteReasonAt: "2026-11-26T10:00:05.000Z",
    };
    expect(ImageAssetSchema.parse(row)).toEqual(row);
    expect(ImageAssetSchema.parse({ ...asset, made: { unstamped: "own_image" } }).made).toEqual({ unstamped: "own_image" });
    // A row from before step 4 parses as it did.
    expect(ImageAssetSchema.parse(asset)).toEqual(asset);
  });

  it("caps the note at 200 characters and the reason at the shared list", () => {
    expect(ImageAssetSchema.safeParse({ ...asset, brandVoteNote: "x".repeat(200) }).success).toBe(true);
    expect(ImageAssetSchema.safeParse({ ...asset, brandVoteNote: "x".repeat(201) }).success).toBe(false);
    expect(ImageAssetSchema.safeParse({ ...asset, brandVoteReason: "ugly" }).success).toBe(false);
    expect(ImageAssetSchema.safeParse({ ...asset, brandVoteVia: "chat" }).success).toBe(false);
  });

  it("parses Steering's version rows as before, and keeps a look's version with its pointers to evidence", () => {
    const steering = { id: "lpv:ten_hearth:linkedin:3", tenantId: "ten_hearth", channel: "linkedin", version: 3, createdAt: "2026-11-01T00:00:00.000Z" };
    const parsed = LearnedPatternVersionSchema.parse(steering);
    expect(parsed).toMatchObject({ createdBy: "auto", perform: [], avoid: [] });
    expect(parsed.items).toBeUndefined();
    const look = {
      ...steering,
      id: "lpv:ten_hearth:image_style.natural_photo:1",
      channel: "image_style.natural_photo",
      version: 1,
      directive: null,
      createdBy: "person" as const,
      loop: "image_style",
      setBy: "person" as const,
      items: [{ id: "look", type: "rule" as const, text: "Overhead daylight, flour on dark wood.", trust: "person" as const, from: "person" as const }],
      change: { op: "edit" as const, itemId: "look" },
      evidenceIds: ["img1", "img2", "img3"],
      excludedEvidence: ["img4"],
      by: "uid_maya",
    };
    expect(LearnedPatternVersionSchema.parse(look)).toMatchObject(look);
    expect(LearnedPatternVersionSchema.safeParse({ ...look, items: [{ ...look.items[0], text: "x".repeat(2001) }] }).success).toBe(false);
    expect(LearnedPatternVersionSchema.safeParse({ ...look, evidenceIds: Array.from({ length: 29 }, (_, i) => `img${i}`) }).success).toBe(false);
    expect(LearnedPatternVersionSchema.safeParse({ ...look, setBy: "vizzy" }).success).toBe(false);
  });
});
