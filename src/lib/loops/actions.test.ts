import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { LookRead } from "@/lib/types/loopDay";

/**
 * The person actions (learning loops step 4, 3.5): Undo, Pause, Forget, Edit the words, Keep and
 * Go back, on Hearth Bakery's Natural photo look, with the real tenant layer on a fake Firestore.
 */

const store = vi.hoisted(() => ({ db: null as unknown as FakeFirestore }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => store.db,
}));

const { appendPatternVersionTx, getPatternVersion, listPatternVersions } = await import("@/lib/tenant/patternVersions");
const { readBrandPointers, runLoopsTransaction, writeBrandPointersTx, LOOP_DAYS } = await import("@/lib/tenant/loops");
const { getAgentAction, listOpenAgentActions } = await import("@/lib/ontology/agentActions");
const { proposeGoBack, GO_BACK_ACTION } = await import("./cards");
const { editLook, forgetLook, forgetPreview, goBackLook, keepLook, setImageLearningPaused, undoLook, resumeSuggestions } = await import("./actions");
const { lookHash } = await import("./write");
const { LOOK_REFUSED_MESSAGE } = await import("./textCheck");
const { sumWeek } = await import("./testing/sumWeek");
const { loopWeekOf } = await import("./count");

const hearth: TenantContext = { tenantId: "ten_hearth", region: "us", source: "idtoken", role: "admin", userId: "usr_maya" };
const NATURAL = "image_style.natural_photo";
const BRAND = "image_style.brand";
const V1_AT = "2027-01-14T09:00:00.000Z";
const V2_AT = "2027-02-20T09:00:00.000Z";
const NOW = new Date("2027-03-01T09:00:00.000Z");
const LOOK1 = "Overhead daylight, flour dusted on dark wood, loaves close up, warm and soft, no people.";
const LOOK2 = "Dark studio backdrop, single loaf, hard side light.";
const BRAND_LOOK = "Warm natural light, rustic wood and linen, honest close ups of bread.";

let db: FakeFirestore;
let removed: string[];
const deps = () => ({ db, now: NOW, removeSearch: async (_ctx: TenantContext, ref: string) => void removed.push(ref) });

beforeEach(async () => {
  db = new FakeFirestore();
  store.db = db;
  removed = [];
  vi.stubEnv("BRAND_STYLE_LOOP_ENABLED", "true");
  vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
  vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "true");
  db.seed("tenants", "ten_hearth", {
    tenantName: "Hearth Bakery",
    rootDomain: "hearth.example.com",
    status: "active",
    region: "us",
    allowedOrigins: [],
    ownerId: "usr_maya",
    brandKit: { learnedImageStyle: BRAND_LOOK, learnedImageStyleUpdatedAt: "2026-12-01T09:00:00.000Z" },
    imageStyle: { defaultStyleId: "natural_photo", learned: { natural_photo: { directive: LOOK1, sampleCount: 5, updatedAt: "2026-12-01T09:00:00.000Z" } } },
  });
  // Images that taught the looks: e1 to e3 liked before version 1, e4 and e5 liked after it, d1 disliked.
  const img = (id: string, vote: "up" | "down", votedAt: string) =>
    db.seed("image_assets", id, { tenantId: "ten_hearth", workspaceId: "ws_h", filename: `${id}.png`, mimeType: "image/png", kind: "social", style: "natural_photo", createdAt: votedAt, brandVote: vote, brandVoteVia: "vote", firstVotedAt: votedAt });
  img("e1", "up", "2027-01-02T09:00:00.000Z");
  img("e2", "up", "2027-01-05T09:00:00.000Z");
  img("e3", "up", "2027-01-08T09:00:00.000Z");
  img("e4", "up", "2027-02-01T09:00:00.000Z");
  img("e5", "up", "2027-02-10T09:00:00.000Z");
  img("d1", "down", "2027-01-03T09:00:00.000Z");
  await runLoopsTransaction(
    hearth,
    async (txn) => {
      const row = (v: number, text: string, at: string, evidenceIds: string[], scope = NATURAL) =>
        appendPatternVersionTx(
          txn,
          hearth,
          {
            channel: scope,
            version: v,
            directive: null,
            perform: [],
            avoid: [],
            judgeRationale: "",
            evidence: [],
            createdBy: "auto",
            createdAt: at,
            loop: "image_style",
            setBy: "learned",
            items: [{ id: `look${v}`, type: "rule", text, trust: "own_content", from: "votes" }],
            change: { op: v === 1 ? "add" : "replace", itemId: `look${v}` },
            evidenceIds,
            evidenceCounts: { liked: evidenceIds.length - 1, disliked: 1, newestAt: at },
          },
          db,
        );
      row(1, LOOK1, V1_AT, ["e1", "e2", "e3", "d1"]);
      row(2, LOOK2, V2_AT, ["e1", "e2", "e4", "e5", "d1"]);
      row(1, BRAND_LOOK, V1_AT, ["e1", "e2", "e3", "d1"], BRAND);
      writeBrandPointersTx(
        txn,
        hearth,
        { scopes: { [NATURAL]: { v: 2, setBy: "learned", adoptedAt: V2_AT }, [BRAND]: { v: 1, setBy: "learned", adoptedAt: V1_AT } }, seededAt: "2027-01-01T00:00:00.000Z" },
        db,
      );
    },
    db,
  );
});
afterEach(() => vi.unstubAllEnvs());

const worse: LookRead = {
  call: "worse",
  decidedBy: "check",
  look: 10,
  check: { before: { hits: 9, n: 10 }, after: { hits: 2, n: 10 } },
  guard: { before: { hits: 1, n: 10 }, after: { hits: 1, n: 10 } },
  usableBefore: 20,
  after: 10,
  next: 20,
  need: null,
  at: NOW.toISOString(),
};

async function card() {
  const r = await proposeGoBack(hearth, { scope: NATURAL, from: 2, to: 1, proposedThisWeek: 0, basis: { read: worse, since: V2_AT, evidence: null } }, { db, now: NOW });
  expect(r.outcome).toBe("proposed");
  return r.id!;
}

describe("Undo", () => {
  it("writes the look before as a new version, leaves out the likes that made it due, counts undone and closes the card", async () => {
    const id = await card();
    const r = await undoLook(hearth, NATURAL, deps());
    expect(r).toEqual({ ok: true, v: 3, restored: 1 });
    const v3 = await getPatternVersion(hearth, NATURAL, 3, db);
    expect(v3).toMatchObject({ createdBy: "undo", setBy: "learned", by: "usr_maya", change: { op: "revert", itemId: "look1" } });
    expect(v3?.items?.[0]?.text).toBe(LOOK1);
    // e4 and e5 came in after version 1 began: the trigger likes. e1 and e2 taught version 1 too.
    expect(v3?.excludedEvidence?.sort()).toEqual(["e4", "e5"]);
    expect((await readBrandPointers(hearth, db)).scopes[NATURAL]).toEqual({ v: 3, setBy: "learned", adoptedAt: NOW.toISOString() });
    expect(sumWeek(db, "ten_hearth", loopWeekOf(NOW))).toMatchObject({ c: { [NATURAL]: { loop_learn: { v2: { learned: { undone: 1 } } } } }, k: { loop_learn: { proposed: 1, expired: 1 } } });
    expect((await getAgentAction(hearth, id as never, { db }))?.declined?.reason).toBe("superseded");
  });

  it("leaves no look when it undoes a first look", async () => {
    expect(await undoLook(hearth, BRAND, deps())).toEqual({ ok: true, v: 2, restored: 0 });
    const v2 = await getPatternVersion(hearth, BRAND, 2, db);
    expect(v2).toMatchObject({ createdBy: "undo", items: [] });
    // Every like of a first look made it due.
    expect(v2?.excludedEvidence?.sort()).toEqual(["e1", "e2", "e3"]);
  });
});

describe("Forget", () => {
  it("removes the words everywhere, leaves out the evidence, clears the old copy and the search entry, and is never undone", async () => {
    const id = await card();
    // The confirm's counts: 4 liked and 1 disliked taught it, 3 of them also taught the brand look.
    expect((await forgetPreview(hearth, NATURAL, deps()))).toEqual({ ok: true, liked: 4, disliked: 1, brandOverlap: 3 });
    const r = await forgetLook(hearth, NATURAL, {}, deps());
    expect(r).toMatchObject({ ok: true, v: 3, scopes: [NATURAL] });
    const rows = await listPatternVersions(hearth, NATURAL, 10, db);
    expect(rows.find((x) => x.version === 2)?.items?.[0]?.text ?? null).toBeNull();
    expect(rows.find((x) => x.version === 1)?.items?.[0]?.text).toBe(LOOK1);
    const v3 = rows.find((x) => x.version === 3)!;
    expect(v3).toMatchObject({ createdBy: "forget", items: [], forgotHash: lookHash(LOOK2), excludedEvidence: ["e1", "e2", "e4", "e5", "d1"] });
    const pointers = await readBrandPointers(hearth, db);
    expect(pointers.forgot?.[NATURAL]?.at).toBe(NOW.toISOString());
    expect(removed).toEqual([`${NATURAL}@2`]);
    // The old copy on the brand record: Natural photo's goes, the brand look stays.
    const t = db.raw("tenants", "ten_hearth") as { imageStyle: { learned: Record<string, unknown> }; brandKit: { learnedImageStyle?: string } };
    expect(t.imageStyle.learned.natural_photo).toBeUndefined();
    expect(t.brandKit.learnedImageStyle).toBe(BRAND_LOOK);
    expect((await getAgentAction(hearth, id as never, { db }))?.declined?.reason).toBe("superseded");
    expect(await undoLook(hearth, NATURAL, deps())).toEqual({ ok: false, error: "forgotten" });
  });

  it("forgets the brand look too when asked", async () => {
    const r = await forgetLook(hearth, NATURAL, { alsoBrand: true }, deps());
    expect(r).toMatchObject({ ok: true, scopes: [NATURAL, BRAND] });
    expect((await getPatternVersion(hearth, BRAND, 1, db))?.items?.[0]?.text ?? null).toBeNull();
    expect((db.raw("tenants", "ten_hearth") as { brandKit: Record<string, unknown> }).brandKit.learnedImageStyle).toBeUndefined();
  });
});

describe("Edit the words", () => {
  it("writes a look set by the person, and refuses a look with a link", async () => {
    expect(await editLook(hearth, NATURAL, "See https://hearth.example.com for the look.", deps())).toEqual({ ok: false, error: "text_refused", message: LOOK_REFUSED_MESSAGE });
    expect(await editLook(hearth, NATURAL, "Overhead daylight, flour on dark wood, loaves and pastries, no people.", deps())).toEqual({ ok: true, v: 3 });
    expect(await getPatternVersion(hearth, NATURAL, 3, db)).toMatchObject({ createdBy: "person", setBy: "person", items: [{ trust: "person", from: "person" }] });
    expect((await readBrandPointers(hearth, db)).scopes[NATURAL]?.setBy).toBe("person");
  });
});

describe("Keep and Go back", () => {
  it("Keep puts keptAt on the pointer with no new version, and answers the card", async () => {
    const id = await card();
    expect(await keepLook(hearth, { cardId: id }, deps())).toEqual({ ok: true, v: 2 });
    expect((await readBrandPointers(hearth, db)).scopes[NATURAL]?.keptAt).toBe(NOW.toISOString());
    expect(await getPatternVersion(hearth, NATURAL, 3, db)).toBeNull();
    const a = await getAgentAction(hearth, id as never, { db });
    expect(a?.declined?.reason).toBe("dismissed");
    expect(await listOpenAgentActions(hearth, { action: GO_BACK_ACTION, now: NOW.toISOString(), db })).toEqual([]);
    // A kept look's card at the same look is never offered again for 30 days.
    const again = await proposeGoBack(hearth, { scope: NATURAL, from: 2, to: 1, proposedThisWeek: 0, previous: { id }, basis: { read: { ...worse, look: 20 }, since: V2_AT, evidence: null } }, { db, now: NOW });
    expect(again.outcome).toBe("quiet");
  });

  it("Go back writes the named version's look again, counts reversed and acts on the card", async () => {
    const id = await card();
    expect(await goBackLook(hearth, { cardId: id }, deps())).toEqual({ ok: true, v: 3, restored: 1 });
    expect((await getPatternVersion(hearth, NATURAL, 3, db))?.items?.[0]?.text).toBe(LOOK1);
    expect((await getAgentAction(hearth, id as never, { db }))?.state).toBe("acted");
    expect(sumWeek(db, "ten_hearth", loopWeekOf(NOW))).toMatchObject({ c: { [NATURAL]: { loop_learn: { v2: { learned: { reversed: 1 } } } } }, k: { loop_learn: { acted: 1 } } });
  });

  it("Go back is refused once the scope moved on, or when the look it would restore was forgotten", async () => {
    const id = await card();
    await editLook(hearth, NATURAL, "Soft window light on flour.", deps());
    expect(await goBackLook(hearth, { cardId: id }, deps())).toEqual({ ok: false, error: "moved" });

    await runLoopsTransaction(hearth, async (txn) => {
      const rows = await listPatternVersions(hearth, NATURAL, 10, db);
      const v1 = rows.find((r) => r.version === 1)!;
      const { removeWordsTx } = await import("@/lib/tenant/patternVersions");
      const p = await readBrandPointers(hearth, db);
      removeWordsTx(txn, hearth, v1, db);
      writeBrandPointersTx(txn, hearth, { ...p, scopes: { ...p.scopes, [NATURAL]: { v: 2, setBy: "learned", adoptedAt: V2_AT } } }, db);
    }, db);
    // The card was answered by the Edit; a worse read on the card's own notice names the scope instead.
    db.seed(LOOP_DAYS, `lv:ten_hearth:${NATURAL}:2`, { tenantId: "ten_hearth", d: { c: {}, looks: { "10": worse } } });
    expect(await goBackLook(hearth, { scope: NATURAL }, deps())).toEqual({ ok: false, error: "words_removed" });
    expect(await keepLook(hearth, { scope: BRAND }, deps())).toEqual({ ok: false, error: "not_worse" });
  });
});

describe("Pause, Resume suggestions and the switch", () => {
  it("pauses and resumes image learning, and keeps the date suggestions resumed", async () => {
    expect(await setImageLearningPaused(hearth, true, deps())).toEqual({ ok: true });
    expect((await readBrandPointers(hearth, db)).pause?.image_style?.at).toBe(NOW.toISOString());
    expect(await setImageLearningPaused(hearth, false, deps())).toEqual({ ok: true });
    expect((await readBrandPointers(hearth, db)).pause?.image_style).toBeUndefined();
    expect(await resumeSuggestions(hearth, deps())).toEqual({ ok: true });
    expect((await readBrandPointers(hearth, db)).cardsResumedAt).toBe(NOW.toISOString());
  });

  it("does nothing with image style versions off, or for a scope that doesn't learn", async () => {
    expect(await undoLook(hearth, "image_style.headline_card", deps())).toEqual({ ok: false, error: "scope" });
    vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "");
    expect(await undoLook(hearth, NATURAL, deps())).toEqual({ ok: false, error: "switch" });
    expect(await setImageLearningPaused(hearth, true, deps())).toEqual({ ok: false, error: "switch" });
    expect((await readBrandPointers(hearth, db)).scopes[NATURAL]?.v).toBe(2);
  });
});
