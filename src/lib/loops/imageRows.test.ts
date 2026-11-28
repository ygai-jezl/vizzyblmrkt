import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLoopsTransaction, writeBrandPointersTx } from "@/lib/tenant/loops";
import { appendPatternVersion } from "@/lib/tenant/patternVersions";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { ImageAsset } from "@/lib/types/imageAsset";
import type { LoopStamp } from "@/lib/types/loopStamp";
import { countImageVote, stampOfImage, voteDeltas, voteSignals, type VoteState } from "./imageRows";
import { sumWeek } from "./testing/sumWeek";

/** What the loops read off an image's row (src/lib/loops/imageRows.ts, learning loops step 4). */

const hearth: TenantContext = { tenantId: "ten_hearth", region: "us", source: "system" };
const NOW = new Date("2027-01-15T10:00:00.000Z");
const NATURAL = "image_style.natural_photo";
const SEEDED_AT = "2026-12-02T09:00:00.000Z";

const untouchable = new Proxy({}, { get: (_t, p) => { throw new Error(`it touched the database (${String(p)})`); } }) as FirestoreLike;

const stamp: LoopStamp = {
  made: "m1.image_style.natural_photo.1.h",
  kind: "post_image",
  scope: NATURAL,
  v: 1,
  arm: "holdback",
  items: [],
  prompt: null,
  tokens: { rules: 0, examples: 0 },
  at: "2027-01-14T09:00:00.000Z",
};

const row = (over: Partial<ImageAsset> = {}): ImageAsset => ({
  id: "img_loaf",
  tenantId: "ten_hearth",
  workspaceId: "ws_hearth",
  filename: "loaf.png",
  mimeType: "image/png",
  kind: "social",
  style: "natural_photo",
  createdAt: "2026-11-20T09:00:00.000Z",
  ...over,
});

function versionsOn() {
  vi.stubEnv("BRAND_STYLE_LOOP_ENABLED", "true");
  vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
  vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "true");
}

/** Hearth, seeded on 2 Dec: Natural photo's version 1 is the look carried over, the brand look nothing. */
async function seededHearth(setBy: "seeded" | "learned" = "seeded") {
  const db = new FakeFirestore();
  await appendPatternVersion(
    hearth,
    {
      channel: NATURAL,
      version: 1,
      directive: null,
      perform: [],
      avoid: [],
      judgeRationale: "",
      evidence: [],
      createdBy: setBy === "seeded" ? "seed" : "auto",
      createdAt: SEEDED_AT,
      loop: "image_style",
      setBy,
      items: [{ id: "look1", type: "rule", text: "Overhead daylight on dark wood.", trust: "own_content", from: setBy === "seeded" ? "seed" : "votes" }],
    },
    db,
  );
  await runLoopsTransaction(
    hearth,
    async (txn) => writeBrandPointersTx(txn, hearth, { scopes: { [NATURAL]: { v: 1, setBy, adoptedAt: SEEDED_AT } }, seededAt: SEEDED_AT }, db),
    db,
  );
  return db;
}

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the stamp an image's signals count against", () => {
  it("is the row's own stamp, and nothing for a person's own image or a row kept with no stamp", async () => {
    expect(await stampOfImage(hearth, row({ made: stamp }), { db: untouchable })).toEqual(stamp);
    expect(await stampOfImage(hearth, row({ made: { unstamped: "own_image" } }), { db: untouchable })).toBeNull();
    expect(await stampOfImage(hearth, row({ kind: "upload" }), { db: untouchable })).toBeNull();
  });

  it("works one out for a row from before versions: its style, arm none, legacy, version 1 when made before the seed it carries", async () => {
    const db = await seededHearth();
    expect(await stampOfImage(hearth, row(), { db })).toEqual({
      made: "m1.image_style.natural_photo.1.n",
      kind: "post_image",
      scope: NATURAL,
      v: 1,
      arm: "none",
      items: [],
      prompt: null,
      tokens: { rules: 0, examples: 0 },
      sources: ["legacy"],
      at: "2026-11-20T09:00:00.000Z",
    });
    // Made after the seed, or a style whose version 1 was learned rather than carried over: version 0.
    expect((await stampOfImage(hearth, row({ createdAt: "2026-12-10T09:00:00.000Z" }), { db }))?.v).toBe(0);
    expect((await stampOfImage(hearth, row(), { db: await seededHearth("learned") }))?.v).toBe(0);
    // Not seeded yet: version 0.
    expect((await stampOfImage(hearth, row(), { db: new FakeFirestore() }))?.made).toBe("m1.image_style.natural_photo.0.n");
  });

  it("maps each library kind to the kind that made it, and a drawn style or none to its own scope with no read", async () => {
    const blog = await stampOfImage(hearth, row({ kind: "blog_hero", style: "headline_card" }), { db: untouchable });
    expect([blog?.kind, blog?.scope, blog?.v]).toEqual(["blog_hero", "image_style.headline_card", 0]);
    const ebook = await stampOfImage(hearth, row({ kind: "ebook", style: "earthy" }), { db: new FakeFirestore() });
    expect([ebook?.kind, ebook?.scope]).toEqual(["ebook_image", NATURAL]);
    const custom = await stampOfImage(hearth, row({ kind: "customized", style: null }), { db: new FakeFirestore() });
    expect([custom?.kind, custom?.scope]).toEqual(["customize_image", "image_style.brand"]);
  });

  it("counts as version 0 when the seed can't be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken = { collection: () => { throw new Error("down"); }, runTransaction: () => { throw new Error("down"); } } as unknown as FirestoreLike;
    expect((await stampOfImage(hearth, row(), { db: broken }))?.v).toBe(0);
    expect(warn).toHaveBeenCalled();
  });
});

describe("a vote's signals", () => {
  const counted = (s: Partial<VoteState>): VoteState => ({ firstVotedAt: "2027-01-10T09:00:00.000Z", ...s });

  it("stand for voted, liked when up, and the reason in its direction", () => {
    expect(voteSignals({})).toEqual({});
    expect(voteSignals({ brandVote: "up" })).toEqual({ voted: 1, liked: 1 });
    expect(voteSignals({ brandVote: "up", brandVoteReason: "layout" })).toEqual({ voted: 1, liked: 1, "liked.layout": 1 });
    expect(voteSignals({ brandVote: "down", brandVoteReason: "mood" })).toEqual({ voted: 1, "disliked.mood": 1 });
  });

  it("move once per image: a first vote counts, re-rating a like moves nothing, a changed vote moves it", () => {
    expect(voteDeltas({}, counted({ brandVote: "up" }))).toEqual({ voted: 1, liked: 1 });
    expect(voteDeltas(counted({ brandVote: "up" }), counted({ brandVote: "up" }))).toEqual({});
    expect(voteDeltas(counted({ brandVote: "up", brandVoteReason: "colours" }), counted({ brandVote: "down" }))).toEqual({ liked: -1, "liked.colours": -1 });
    expect(voteDeltas(counted({ brandVote: "down" }), counted({ brandVote: "down", brandVoteReason: "fake" }))).toEqual({ "disliked.fake": 1 });
    expect(voteDeltas(counted({ brandVote: "down", brandVoteReason: "fake" }), counted({ brandVote: "down", brandVoteReason: "mood" }))).toEqual({ "disliked.fake": -1, "disliked.mood": 1 });
    expect(voteDeltas(counted({ brandVote: "down", brandVoteReason: "fake" }), counted({ brandVote: null }))).toEqual({ voted: -1, "disliked.fake": -1 });
  });

  it("count the whole new vote of a row voted before versions, which was never counted", () => {
    expect(voteDeltas({ brandVote: "up" }, counted({ brandVote: "down" }))).toEqual({ voted: 1 });
    expect(voteDeltas({ brandVote: "up" }, counted({ brandVote: "up" }))).toEqual({ voted: 1, liked: 1 });
    expect(voteDeltas({ brandVote: "up" }, { brandVote: null })).toEqual({});
  });
});

describe("counting a vote", () => {
  it("adds its moves against the image's stamp, and nothing with versions off", async () => {
    const db = new FakeFirestore();
    const before = row({ made: stamp });
    const after = row({ made: stamp, brandVote: "down", brandVoteReason: "mood", firstVotedAt: NOW.toISOString() });
    await countImageVote(hearth, before, after, { db, now: NOW });
    expect(sumWeek(db, hearth.tenantId, "2027-W02")).toEqual({});

    versionsOn();
    await countImageVote(hearth, before, after, { db, now: NOW });
    expect(sumWeek(db, hearth.tenantId, "2027-W02")).toEqual({ c: { [NATURAL]: { post_image: { v1: { holdback: { voted: 1, "disliked.mood": 1 } } } } } });
  });

  it("counts a person's own image (an upload) as an own image's vote, with no stamp, and moves it when it changes", async () => {
    versionsOn();
    const db = new FakeFirestore();
    const upload = row({ kind: "upload", style: null, made: { unstamped: "own_image" }, brandVote: "up", brandVoteVia: "upload", firstVotedAt: NOW.toISOString() });
    await countImageVote(hearth, { brandVote: null }, upload, { db, now: NOW });
    expect(sumWeek(db, hearth.tenantId, "2027-W02")).toEqual({ o: { image: { voted: 1, liked: 1 } } });
    await countImageVote(hearth, upload, { ...upload, brandVote: "down" }, { db, now: NOW });
    expect(sumWeek(db, hearth.tenantId, "2027-W02")).toEqual({ o: { image: { voted: 1, liked: 0 } } });
  });
});
