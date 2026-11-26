import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { LoopStamp } from "@/lib/types/loopStamp";

// recordImageAsset takes the id minted before learnedFor ran, and its stamp (learning loops step 4).
const store = vi.hoisted(() => ({ db: null as unknown as FakeFirestore }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => store.db,
}));

const { newImageAssetId, recordImageAsset, setImageBrandVote, setImageVoteReason, cleanVoteNote } = await import("./brandKit");
const { sumWeek } = await import("@/lib/loops/testing/sumWeek");

const hearth = { tenantId: "ten_hearth", region: "us" } as const;
const stamp: LoopStamp = {
  made: "m1.image_style.natural_photo.1.l",
  kind: "post_image",
  scope: "image_style.natural_photo",
  v: 1,
  arm: "learned",
  items: ["look1"],
  prompt: null,
  tokens: { rules: 24, examples: 0 },
  at: "2027-01-15T10:00:00.000Z",
};
const input = {
  workspaceId: "ws_hearth",
  filename: "loaf.png",
  mimeType: "image/png",
  kind: "social" as const,
  style: "natural_photo",
  made: { unstamped: "image_versions_off" as const },
};

function versionsOn() {
  vi.stubEnv("BRAND_STYLE_LOOP_ENABLED", "true");
  vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
  vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "true");
}

beforeEach(() => {
  store.db = new FakeFirestore();
  vi.unstubAllEnvs();
});
afterEach(() => vi.unstubAllEnvs());

describe("recordImageAsset", () => {
  it("stores the image under the id it was given, so the holdback's hash and the row name the same image", async () => {
    const id = newImageAssetId();
    const row = await recordImageAsset(hearth, { ...input, id });
    expect(row.id).toBe(id);
    expect(store.db.raw("image_assets", id)).toMatchObject({ tenantId: "ten_hearth", filename: "loaf.png" });
  });

  it("mints an id when given none, as before", async () => {
    const row = await recordImageAsset(hearth, input);
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("refuses an id a row already has, or one that isn't a document id", async () => {
    const id = newImageAssetId();
    await recordImageAsset(hearth, { ...input, id });
    await expect(recordImageAsset(hearth, { ...input, id })).rejects.toThrow();
    await expect(recordImageAsset(hearth, { ...input, id: "a/b" })).rejects.toThrow(/letters, digits/);
  });

  it("keeps its stamp with image style versions on", async () => {
    versionsOn();
    const own = await recordImageAsset(hearth, { ...input, id: "img-stamped", made: stamp });
    expect(own.made).toEqual(stamp);
    expect(store.db.raw("image_assets", "img-stamped")).toMatchObject({ made: stamp });
    await recordImageAsset(hearth, { ...input, kind: "upload", id: "img-upload", made: { unstamped: "own_image" } });
    expect(store.db.raw("image_assets", "img-upload")).toMatchObject({ made: { unstamped: "own_image" } });
  });

  it("keeps the row exactly as before with them off (decision 22)", async () => {
    const row = await recordImageAsset(hearth, { ...input, id: "img-off", made: { unstamped: "image_versions_off" } });
    expect(row).not.toHaveProperty("made");
    expect(store.db.raw("image_assets", "img-off")).not.toHaveProperty("made");
  });

  it("keeps how an upload's like was given, and when, only with versions on", async () => {
    const upload = { ...input, kind: "upload" as const, made: { unstamped: "own_image" as const }, brandVote: "up" as const, brandVoteVia: "upload" as const, firstVotedAt: "2027-01-15T10:00:00.000Z" };
    await recordImageAsset(hearth, { ...upload, id: "img-up-off" });
    expect(store.db.raw("image_assets", "img-up-off")).not.toHaveProperty("brandVoteVia");
    expect(store.db.raw("image_assets", "img-up-off")).not.toHaveProperty("firstVotedAt");
    versionsOn();
    await recordImageAsset(hearth, { ...upload, id: "img-up-on" });
    expect(store.db.raw("image_assets", "img-up-on")).toMatchObject({ brandVoteVia: "upload", firstVotedAt: "2027-01-15T10:00:00.000Z" });
  });
});

describe("votes and the why behind them (learning loops step 4, 3.4 and 3.11)", () => {
  const NOW = new Date("2027-01-15T10:00:00.000Z");
  const LATER = new Date("2027-01-16T10:00:00.000Z");
  const WEEK = "2027-W02";
  const NATURAL = "image_style.natural_photo";
  const ctx = { ...hearth, source: "idtoken" as const };
  const counts = () => sumWeek(store.db, "ten_hearth", WEEK);
  const counted = (signals: Record<string, number>) => ({ c: { [NATURAL]: { post_image: { v1: { learned: signals } } } } });

  async function loaf(over: Record<string, unknown> = {}) {
    store.db.seed("image_assets", "img_loaf", { ...input, tenantId: "ten_hearth", createdAt: "2027-01-14T10:00:00.000Z", made: stamp, ...over });
  }

  it("with versions off writes the vote exactly as before, and counts nothing", async () => {
    await loaf();
    const row = await setImageBrandVote(ctx, "img_loaf", { vote: "up", rating: 9 }, { now: NOW });
    expect(row).toMatchObject({ brandVote: "up", brandRating: 9, brandVoteSetAt: NOW.toISOString() });
    expect(store.db.raw("image_assets", "img_loaf")).not.toHaveProperty("brandVoteVia");
    expect(store.db.raw("image_assets", "img_loaf")).not.toHaveProperty("firstVotedAt");
    expect(store.db.dump("loop_days")).toEqual([]);
    expect(await setImageBrandVote(ctx, "img_none", { vote: "up" })).toBeNull();
  });

  it("with versions on keeps how and when it was first voted, and counts each image once", async () => {
    versionsOn();
    await loaf();
    const first = await setImageBrandVote(ctx, "img_loaf", { vote: "up", rating: 9 }, { now: NOW });
    expect(first).toMatchObject({ brandVote: "up", brandVoteVia: "vote", firstVotedAt: NOW.toISOString() });
    expect(counts()).toEqual(counted({ voted: 1, liked: 1 }));

    // Re-rating the like moves nothing and keeps the first vote's time.
    const rerated = await setImageBrandVote(ctx, "img_loaf", { vote: "up", rating: 10 }, { now: LATER });
    expect(rerated).toMatchObject({ brandRating: 10, firstVotedAt: NOW.toISOString() });
    expect(counts()).toEqual(counted({ voted: 1, liked: 1 }));

    // What works, then a change of mind: the reason goes with the vote, and the counts move once.
    expect(await setImageVoteReason(ctx, "img_loaf", { reason: "colours", note: "warm  crust\ncolours" }, { now: NOW })).toMatchObject({
      ok: true,
      image: { brandVoteReason: "colours", brandVoteNote: "warm crust colours", brandVoteReasonAt: NOW.toISOString() },
    });
    expect(counts()).toEqual(counted({ voted: 1, liked: 1, "liked.colours": 1 }));
    const down = await setImageBrandVote(ctx, "img_loaf", { vote: "down" }, { now: LATER });
    expect(down).toMatchObject({ brandVote: "down", brandRating: null, brandVoteReason: null, brandVoteNote: null, brandVoteReasonAt: null, firstVotedAt: NOW.toISOString() });
    expect(counts()).toEqual(counted({ voted: 1, liked: 0, "liked.colours": 0 }));

    // A cleared vote takes its count away; the first vote's time stays.
    const cleared = await setImageBrandVote(ctx, "img_loaf", { vote: null }, { now: LATER });
    expect(cleared).toMatchObject({ brandVote: null, brandVoteVia: null, firstVotedAt: NOW.toISOString() });
    expect(counts()).toEqual(counted({ voted: 0, liked: 0, "liked.colours": 0 }));
  });

  it("keeps the vote as the image's outcome while it is at most 14 days old, and never changes it after", async () => {
    versionsOn();
    await loaf();
    await setImageBrandVote(ctx, "img_loaf", { vote: "up" }, { now: NOW });
    expect(store.db.raw("image_assets", "img_loaf")).toMatchObject({ outcomeVote: "up" });
    await setImageBrandVote(ctx, "img_loaf", { vote: "down" }, { now: LATER });
    expect(store.db.raw("image_assets", "img_loaf")).toMatchObject({ outcomeVote: "down" });
    // Past 14 days a change or a clear moves the vote, never its outcome.
    const day30 = new Date("2027-02-13T10:00:00.000Z");
    await setImageBrandVote(ctx, "img_loaf", { vote: "up" }, { now: day30 });
    expect(store.db.raw("image_assets", "img_loaf")).toMatchObject({ brandVote: "up", outcomeVote: "down" });
    await setImageBrandVote(ctx, "img_loaf", { vote: null }, { now: day30 });
    expect(store.db.raw("image_assets", "img_loaf")).toMatchObject({ brandVote: null, outcomeVote: "down" });
  });

  it("dates the first vote of an image voted before versions to when it was made, and counts its vote once", async () => {
    versionsOn();
    await loaf({ brandVote: "up", brandRating: 8, brandVoteSetAt: "2027-01-14T12:00:00.000Z" });
    const row = await setImageBrandVote(ctx, "img_loaf", { vote: "up", rating: 9 }, { now: NOW });
    expect(row?.firstVotedAt).toBe("2027-01-14T10:00:00.000Z");
    expect(counts()).toEqual(counted({ voted: 1, liked: 1 }));
  });

  it("keeps a reason only for the vote's direction, and a note only when it passes the text check", async () => {
    versionsOn();
    await loaf();
    expect(await setImageVoteReason(ctx, "img_loaf", { reason: "fake" })).toEqual({ ok: false, error: "no_vote" });
    await setImageBrandVote(ctx, "img_loaf", { vote: "down" }, { now: NOW });
    expect(await setImageVoteReason(ctx, "img_loaf", { reason: "layout" })).toEqual({ ok: false, error: "invalid_reason" });
    expect(await setImageVoteReason(ctx, "img_loaf", { reason: null, note: "too dark" })).toEqual({ ok: false, error: "invalid_reason" });
    expect(await setImageVoteReason(ctx, "img_loaf", { reason: "mood", note: "more like hearthbakery.com" })).toEqual({ ok: false, error: "note_refused" });
    expect(await setImageVoteReason(ctx, "img_gone", { reason: "mood" })).toEqual({ ok: false, error: "not_found" });
    expect(store.db.raw("image_assets", "img_loaf")?.brandVoteReason ?? null).toBeNull();
    expect(counts()).toEqual(counted({ voted: 1 }));

    expect(await setImageVoteReason(ctx, "img_loaf", { reason: "mood", note: "too dark for a bakery window" }, { now: NOW })).toMatchObject({ ok: true });
    expect(await setImageVoteReason(ctx, "img_loaf", { reason: "fake" }, { now: LATER })).toMatchObject({ ok: true, image: { brandVoteReason: "fake", brandVoteNote: null } });
    expect(counts()).toEqual(counted({ voted: 1, "disliked.mood": 0, "disliked.fake": 1 }));
    expect(await setImageVoteReason(ctx, "img_loaf", { reason: null }, { now: LATER })).toMatchObject({ ok: true, image: { brandVoteReason: null, brandVoteNote: null, brandVoteReasonAt: null } });
    expect(counts()).toEqual(counted({ voted: 1, "disliked.mood": 0, "disliked.fake": 0 }));
  });

  it("keeps a note as plain text on one line, at most 200 characters", () => {
    expect(cleanVoteNote("  too\tdark \u0007 for\n a window ")).toBe("too dark for a window");
    expect(cleanVoteNote("   ")).toBeNull();
    expect(cleanVoteNote(null)).toBeNull();
    expect(cleanVoteNote("x".repeat(250))?.length).toBe(200);
  });
});
