import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { forTenant } from "@/lib/tenant";
import { LOOP_DAYS, readBrandPointers, runLoopsTransaction, writeBrandPointersTx } from "@/lib/tenant/loops";
import { appendPatternVersionTx, getPatternVersion, LEARNED_PATTERN_VERSIONS } from "@/lib/tenant/patternVersions";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { ImageAsset } from "@/lib/types/imageAsset";
import type { BrandPointers } from "@/lib/types/loopDay";
import { LOOP_RULES } from "./registry";
import { LOOK_REFUSED_MESSAGE, LOOK_WORDS_HELP } from "./textCheck";
import { checkLookText, proposeLearned } from "./write";

/** The one writer (src/lib/loops/write.ts, learning loops step 4, 3.4 of the plan for steps 4 and 5). */

const hearth: TenantContext = { tenantId: "ten_hearth", region: "us", source: "system" };
const lumen: TenantContext = { tenantId: "ten_lumen", region: "eu", source: "system" };
const NATURAL = "image_style.natural_photo";
const NOW = new Date("2027-01-14T09:00:00.000Z");
const LOOK = "Overhead daylight, flour dusted on dark wood, loaves close up, warm and soft, no people.";

function versionsOn() {
  vi.stubEnv("BRAND_STYLE_LOOP_ENABLED", "true");
  vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
  vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "true");
}
beforeEach(versionsOn);
afterEach(() => vi.unstubAllEnvs());

async function seeded(db: FakeFirestore, ctx: TenantContext = hearth, more: Partial<BrandPointers> = {}) {
  await runLoopsTransaction(ctx, async (txn) => writeBrandPointersTx(txn, ctx, { scopes: {}, seededAt: "2026-12-01T09:00:00.000Z", ...more } as BrandPointers, db), db);
}

let n = 0;
async function image(db: FakeFirestore, over: Partial<ImageAsset> = {}, ctx: TenantContext = hearth): Promise<string> {
  const id = `img-${++n}`;
  await forTenant(ctx, db).imageAssets.create(id, {
    workspaceId: "ws",
    filename: `${id}.png`,
    mimeType: "image/png",
    kind: "social",
    style: "natural_photo",
    createdAt: "2027-01-10T09:00:00.000Z",
    brandVote: "up",
    brandVoteVia: "vote",
    firstVotedAt: "2027-01-11T09:00:00.000Z",
    ...over,
  } as Omit<ImageAsset, "id" | "tenantId">);
  return id;
}

async function evidence(db: FakeFirestore): Promise<string[]> {
  return [
    await image(db),
    await image(db, { firstVotedAt: "2027-01-12T09:00:00.000Z" }),
    await image(db, { firstVotedAt: "2027-01-14T08:00:00.000Z" }),
    await image(db, { brandVote: "down", brandVoteReason: "mood" }),
    await image(db, { brandVote: "down", brandVoteReason: "mood", brandVoteNote: "too dark for a bakery window" }),
  ];
}

describe("checkLookText", () => {
  it("keeps one line of plain words", () => {
    expect(checkLookText(`  ${LOOK}\n`)).toEqual({ ok: true, text: LOOK });
  });

  it("refuses a link, an email address, a handle or a phone number, never cleaning them out", () => {
    expect(checkLookText(`${LOOK} See hearthbakery.com/menu.`)).toEqual({ ok: false, reason: "trust", code: "link" });
    expect(checkLookText(`${LOOK} Ask maya@example.com.`)).toEqual({ ok: false, reason: "trust", code: "email" });
    expect(checkLookText(`${LOOK} Like @hearthbakery.`)).toEqual({ ok: false, reason: "trust", code: "handle" });
    expect(checkLookText(`${LOOK} Call 020 7946 0958.`)).toEqual({ ok: false, reason: "trust", code: "phone" });
  });

  it("refuses empty words and words past LOOP_RULES.lookChars", () => {
    expect(checkLookText("   ")).toEqual({ ok: false, reason: "error", code: "empty" });
    expect(checkLookText(null)).toEqual({ ok: false, reason: "error", code: "empty" });
    expect(checkLookText("a".repeat(LOOP_RULES.lookChars + 1))).toEqual({ ok: false, reason: "full", code: "too_long" });
  });

  it("has refusal words in house style for the Edit the words box", () => {
    for (const words of [LOOK_WORDS_HELP, LOOK_REFUSED_MESSAGE]) expect([...dashesIn(words), ...aiTellsIn(words)]).toEqual([]);
    expect(LOOK_REFUSED_MESSAGE).toBe("This look can't be saved: it has a link, email address, handle or phone number. Take it out and save again.");
  });
});

describe("proposeLearned", () => {
  it("adopts a first look as version 1, with the row and the pointer in one commit", async () => {
    const db = new FakeFirestore();
    await seeded(db);
    const ids = await evidence(db);
    const r = await proposeLearned(hearth, NATURAL, { op: "add", text: LOOK }, ids, { basedOn: 0, now: NOW, db });
    expect(r).toEqual({ ok: true, v: 1, itemId: "look1" });
    const row = await getPatternVersion(hearth, NATURAL, 1, db);
    expect(row).toMatchObject({
      channel: NATURAL,
      loop: "image_style",
      setBy: "learned",
      createdBy: "auto",
      directive: null,
      items: [{ id: "look1", type: "rule", text: LOOK, trust: "own_content", from: "votes" }],
      change: { op: "add", itemId: "look1" },
      evidenceIds: ids,
      evidenceCounts: { liked: 3, disliked: 2, newestAt: "2027-01-14T08:00:00.000Z", downReasons: { mood: 2 } },
    });
    expect((await readBrandPointers(hearth, db)).scopes[NATURAL]).toEqual({ v: 1, setBy: "learned", adoptedAt: NOW.toISOString() });
  });

  it("keeps one item per version, and no note, member or brand words on the row", async () => {
    const db = new FakeFirestore();
    await seeded(db);
    const ids = await evidence(db);
    await proposeLearned(hearth, NATURAL, { op: "add", text: LOOK }, ids, { basedOn: 0, now: NOW, db });
    const raw = JSON.stringify(db.raw(LEARNED_PATTERN_VERSIONS, `lpv:ten_hearth:${NATURAL}:1`));
    expect(raw).not.toContain("too dark");
    expect(raw).not.toContain('"by"');
    expect((await getPatternVersion(hearth, NATURAL, 1, db))?.items).toHaveLength(1);
  });

  it("refuses evidence a person didn't vote on or upload, or that isn't this brand's", async () => {
    const db = new FakeFirestore();
    await seeded(db);
    const ids = await evidence(db);
    const legacy = await image(db, { brandVoteVia: null });
    const cleared = await image(db, { brandVote: null });
    const theirs = await image(db, {}, lumen);
    for (const bad of [legacy, cleared, theirs, "missing"]) {
      expect(await proposeLearned(hearth, NATURAL, { op: "add", text: LOOK }, [...ids, bad], { basedOn: 0, now: NOW, db })).toEqual({ ok: false, reason: "trust", code: "evidence" });
    }
    expect(await proposeLearned(hearth, NATURAL, { op: "add", text: LOOK }, [], { basedOn: 0, now: NOW, db })).toEqual({ ok: false, reason: "trust", code: "evidence_ids" });
    expect(await proposeLearned(hearth, NATURAL, { op: "add", text: LOOK }, [ids[0]!, ids[0]!], { basedOn: 0, now: NOW, db })).toEqual({ ok: false, reason: "trust", code: "evidence_ids" });
    expect(await getPatternVersion(hearth, NATURAL, 1, db)).toBeNull();
  });

  it("takes an upload as evidence, which counts as liked", async () => {
    const db = new FakeFirestore();
    await seeded(db);
    const ups = [await image(db, { kind: "upload", style: null, brandVoteVia: "upload" }), await image(db, { kind: "upload", style: null, brandVoteVia: "upload" })];
    expect(await proposeLearned(hearth, "image_style.brand", { op: "add", text: LOOK }, ups, { basedOn: 0, now: NOW, db })).toMatchObject({ ok: true, v: 1 });
  });

  it("refuses a look with a link, email address, handle or phone number, and writes nothing", async () => {
    const db = new FakeFirestore();
    await seeded(db);
    const ids = await evidence(db);
    expect(await proposeLearned(hearth, NATURAL, { op: "add", text: `${LOOK} www.hearthbakery.com` }, ids, { basedOn: 0, now: NOW, db })).toEqual({ ok: false, reason: "trust", code: "link" });
    expect(await getPatternVersion(hearth, NATURAL, 1, db)).toBeNull();
    expect((await readBrandPointers(hearth, db)).scopes[NATURAL]).toBeUndefined();
  });

  it("refuses with versions off, an unknown scope, before seeding, while paused and on a look a person set", async () => {
    const db = new FakeFirestore();
    const ids = await evidence(db);
    const propose = (scope = NATURAL, basedOn = 0) => proposeLearned(hearth, scope, { op: "add", text: LOOK }, ids, { basedOn, now: NOW, db });
    vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "false");
    expect(await propose()).toEqual({ ok: false, reason: "switch" });
    versionsOn();
    expect(await propose("image_style.headline_card")).toEqual({ ok: false, reason: "error", code: "scope" });
    expect(await propose()).toEqual({ ok: false, reason: "error", code: "not_seeded" });
    await seeded(db, hearth, { pause: { image_style: { at: NOW.toISOString() } } });
    expect(await propose()).toEqual({ ok: false, reason: "paused" });
    await seeded(db, hearth, { scopes: { [NATURAL]: { v: 2, setBy: "person", adoptedAt: NOW.toISOString() } } });
    expect(await propose(NATURAL, 2)).toEqual({ ok: false, reason: "off_by_person", code: "set_by_person" });
  });

  it("refuses when a person or another learn moved the scope since the learner looked", async () => {
    const db = new FakeFirestore();
    await seeded(db);
    const ids = await evidence(db);
    expect(await proposeLearned(hearth, NATURAL, { op: "add", text: LOOK }, ids, { basedOn: 0, now: NOW, db })).toMatchObject({ ok: true, v: 1 });
    expect(await proposeLearned(hearth, NATURAL, { op: "add", text: LOOK }, ids, { basedOn: 0, now: NOW, db })).toEqual({ ok: false, reason: "error", code: "moved" });
    expect(await proposeLearned(hearth, NATURAL, { op: "replace", text: `${LOOK} Softer.` }, ids, { basedOn: 1, now: NOW, db })).toEqual({ ok: true, v: 2, itemId: "look2" });
  });

  it("stops a second writer through create(): a row already at the next version fails the whole commit", async () => {
    const db = new FakeFirestore();
    await seeded(db);
    const ids = await evidence(db);
    // A row that is already there for version 1, with no pointer to it (a writer that lost its commit halfway can't leave this, but a racing one can).
    await runLoopsTransaction(
      hearth,
      async (txn) =>
        appendPatternVersionTx(
          txn,
          hearth,
          { channel: NATURAL, version: 1, directive: null, perform: [], avoid: [], judgeRationale: "", evidence: [], createdBy: "auto", createdAt: NOW.toISOString(), setBy: "learned", items: [] },
          db,
        ),
      db,
    );
    expect(await proposeLearned(hearth, NATURAL, { op: "add", text: LOOK }, ids, { basedOn: 0, now: NOW, db })).toEqual({ ok: false, reason: "error", code: "conflict" });
    expect((await readBrandPointers(hearth, db)).scopes[NATURAL]).toBeUndefined();
    expect((await getPatternVersion(hearth, NATURAL, 1, db))?.items).toEqual([]);
  });

  it("writes only this brand's documents", async () => {
    const db = new FakeFirestore();
    await seeded(db);
    await seeded(db, lumen);
    const ids = await evidence(db);
    await proposeLearned(hearth, NATURAL, { op: "add", text: LOOK }, ids, { basedOn: 0, now: NOW, db });
    expect(db.raw(LOOP_DAYS, "lb:ten_lumen")).toMatchObject({ d: { scopes: {} } });
    expect(await getPatternVersion(lumen, NATURAL, 1, db)).toBeNull();
  });
});
