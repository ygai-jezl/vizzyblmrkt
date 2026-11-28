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
const { readBrandPointers, readLaneState, runLoopsTransaction, writeBrandPointersTx, LOOP_DAYS } = await import("@/lib/tenant/loops");
const { getAgentAction, listOpenAgentActions } = await import("@/lib/ontology/agentActions");
const { proposeGoBack, GO_BACK_ACTION } = await import("./cards");
const { editLook, forgetLook, forgetPreview, forgetUndone, goBackLook, keepLook, setHelpCheck, setImageLearningPaused, undoLook, resumeSuggestions } = await import("./actions");
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

describe("the learning setting", () => {
  it("turns Help check that learning works off and on, keeping the first day it went off", async () => {
    expect(await setHelpCheck(hearth, false, deps())).toEqual({ ok: true, offSince: NOW.toISOString() });
    expect((await readBrandPointers(hearth, db)).fleetOptOut).toEqual({ at: NOW.toISOString() });
    expect(await setHelpCheck(hearth, false, { ...deps(), now: new Date("2027-03-05T09:00:00.000Z") })).toEqual({ ok: true, offSince: NOW.toISOString() });
    expect(await setHelpCheck(hearth, true, deps())).toEqual({ ok: true, offSince: null });
    const pointers = await readBrandPointers(hearth, db);
    expect(pointers.fleetOptOut).toBeUndefined();
    expect(pointers.scopes[NATURAL]?.v).toBe(2);
    // With the learning loops off nothing is counted across brands, so the lane's state is left as it was.
    expect(await readLaneState(hearth, db)).toEqual({});
  });

  it("with the learning loops on, keeps the week a time out ended in on the lane's state, keeping what is there", async () => {
    vi.stubEnv("LOOPS_ENABLED", "true");
    db.seed(LOOP_DAYS, `ls:${hearth.tenantId}`, { tenantId: hearth.tenantId, d: { heartbeatWeek: "2027-W08", runs: 4 } });
    expect(await setHelpCheck(hearth, false, deps())).toMatchObject({ ok: true });
    expect(await readLaneState(hearth, db)).toEqual({ heartbeatWeek: "2027-W08", runs: 4 });
    expect(await setHelpCheck(hearth, true, { ...deps(), now: new Date("2027-03-04T09:00:00.000Z") })).toEqual({ ok: true, offSince: null });
    expect(await readLaneState(hearth, db)).toEqual({ heartbeatWeek: "2027-W08", runs: 4, optedOutThrough: loopWeekOf(NOW) });
    // Turned on again while already on: nothing more is kept.
    expect(await setHelpCheck(hearth, true, { ...deps(), now: new Date("2027-03-20T09:00:00.000Z") })).toEqual({ ok: true, offSince: null });
    expect((await readLaneState(hearth, db)).optedOutThrough).toBe(loopWeekOf(NOW));
  });

  it("does nothing with versions and the learning loops off", async () => {
    vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "");
    expect(await setHelpCheck(hearth, false, deps())).toEqual({ ok: false, error: "switch" });
    expect(await forgetUndone(hearth, NATURAL, deps())).toEqual({ ok: false, error: "switch" });
  });

  it("with only the learning loops on, still lets a brand leave the counts across brands (decision 4)", async () => {
    vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "");
    vi.stubEnv("LOOPS_ENABLED", "true");
    expect(await setHelpCheck(hearth, false, deps())).toEqual({ ok: true, offSince: NOW.toISOString() });
    expect((await readBrandPointers(hearth, db)).fleetOptOut).toEqual({ at: NOW.toISOString() });
    // The image actions stay off.
    expect(await forgetUndone(hearth, NATURAL, deps())).toEqual({ ok: false, error: "switch" });
  });
});

describe("Undo", () => {
  it("writes the look before as a new version, leaves out the likes that made it due, counts undone and closes the card", async () => {
    const id = await card();
    const r = await undoLook(hearth, NATURAL, deps());
    expect(r).toEqual({ ok: true, v: 3, restored: 1, restoredAt: V1_AT, wasPerson: false });
    const v3 = await getPatternVersion(hearth, NATURAL, 3, db);
    expect(v3).toMatchObject({ createdBy: "undo", setBy: "learned", by: "usr_maya", change: { op: "revert", itemId: "look1" } });
    expect(v3?.items?.[0]?.text).toBe(LOOK1);
    // e4 and e5 came in after version 1 began: the trigger likes. e1 and e2 taught version 1 too.
    expect(v3?.excludedEvidence?.sort()).toEqual(["e4", "e5"]);
    expect((await readBrandPointers(hearth, db)).scopes[NATURAL]).toEqual({ v: 3, setBy: "learned", adoptedAt: NOW.toISOString() });
    expect(sumWeek(db, "ten_hearth", loopWeekOf(NOW))).toMatchObject({ c: { [NATURAL]: { loop_learn: { v2: { learned: { undone: 1 } } } } }, k: { loop_learn: { proposed: 1, expired: 1 } } });
    expect((await getAgentAction(hearth, id as never, { db }))?.declined?.reason).toBe("superseded");
  });

  it("forgets the look an Undo just left, keeping the look in use (Don't learn this again: Forget)", async () => {
    expect(await forgetUndone(hearth, NATURAL, deps())).toEqual({ ok: false, error: "nothing_to_forget" });
    await undoLook(hearth, NATURAL, deps());
    expect(await forgetUndone(hearth, NATURAL, deps())).toEqual({ ok: true, v: 3, scopes: [NATURAL] });
    // Version 2's words are gone; version 3, the look in use, keeps version 1's.
    expect((await getPatternVersion(hearth, NATURAL, 2, db))?.items?.[0]?.text ?? null).toBeNull();
    const v3 = await getPatternVersion(hearth, NATURAL, 3, db);
    expect(v3?.items?.[0]?.text).toBe(LOOK1);
    expect(v3?.forgotHash).toBe(lookHash(LOOK2));
    expect(v3?.excludedEvidence?.sort()).toEqual(["d1", "e1", "e2", "e4", "e5"]);
    expect((await readBrandPointers(hearth, db)).scopes[NATURAL]?.v).toBe(3);
    expect(removed).toEqual([`${NATURAL}@2`]);
    // It was learned, not carried over: the old copy on the brand record stays.
    expect((db.raw("tenants", "ten_hearth") as { imageStyle?: { learned?: Record<string, unknown> } })?.imageStyle?.learned?.natural_photo).toBeTruthy();
    // Done once: nothing is left to forget.
    expect(await forgetUndone(hearth, NATURAL, deps())).toEqual({ ok: false, error: "nothing_to_forget" });
  });

  it("says no version came back when it undoes a look learned after a Forget", async () => {
    expect(await forgetLook(hearth, NATURAL, {}, deps())).toMatchObject({ ok: true, v: 3 });
    // A look learned after the Forget, then undone: the Forget's version has no look to bring back.
    await runLoopsTransaction(
      hearth,
      async (txn) => {
        const p = await readBrandPointers(hearth, db);
        appendPatternVersionTx(
          txn,
          hearth,
          {
            channel: NATURAL,
            version: 4,
            directive: null,
            perform: [],
            avoid: [],
            judgeRationale: "",
            evidence: [],
            createdBy: "auto",
            createdAt: NOW.toISOString(),
            loop: "image_style",
            setBy: "learned",
            items: [{ id: "look4", type: "rule", text: "Soft window light on flour.", trust: "own_content", from: "votes" }],
            change: { op: "add", itemId: "look4" },
          },
          db,
        );
        writeBrandPointersTx(txn, hearth, { ...p, scopes: { ...p.scopes, [NATURAL]: { v: 4, setBy: "learned", adoptedAt: NOW.toISOString() } } }, db);
      },
      db,
    );
    expect(await undoLook(hearth, NATURAL, deps())).toEqual({ ok: true, v: 5, restored: 0, restoredAt: null, wasPerson: false });
    expect((await getPatternVersion(hearth, NATURAL, 5, db))?.items).toEqual([]);
    const { historyLine, undoDoneLine } = await import("./learnedWords");
    expect(undoDoneLine({ scope: NATURAL, restored: 0, wasPerson: false, brandLook: true })).toBe("Undone. Natural photo has no look of its own again, so it uses your brand's look.");
    expect(historyLine({ v: 5, createdBy: "undo", createdAt: NOW.toISOString(), hasLook: false, who: "you" }, { inUse: true })).toBe("Version 5, 1 Mar, undone by you. In use.");
  });

  it("leaves no look when it undoes a first look", async () => {
    expect(await undoLook(hearth, BRAND, deps())).toEqual({ ok: true, v: 2, restored: 0, restoredAt: null, wasPerson: false });
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
    expect((await forgetPreview(hearth, NATURAL, deps()))).toEqual({ ok: true, liked: 4, disliked: 1, uploaded: 0, brandOverlap: 3 });
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

  it("leaves out the images that taught a look an Undo brought back, and offers to forget the brand look with it", async () => {
    expect(await undoLook(hearth, NATURAL, deps())).toMatchObject({ ok: true, v: 3, restored: 1 });
    // Version 3 is version 1's look again, with the images that taught it.
    expect((await getPatternVersion(hearth, NATURAL, 3, db))?.evidenceIds).toEqual(["e1", "e2", "e3", "d1"]);
    // All 4 also taught the brand look, so the confirm offers to forget it too.
    expect(await forgetPreview(hearth, NATURAL, deps())).toEqual({ ok: true, liked: 3, disliked: 1, uploaded: 0, brandOverlap: 4 });
    expect(await forgetLook(hearth, NATURAL, {}, deps())).toMatchObject({ ok: true, v: 4 });
    const v4 = await getPatternVersion(hearth, NATURAL, 4, db);
    expect(v4).toMatchObject({ createdBy: "forget", forgotHash: lookHash(LOOK1) });
    expect(v4?.excludedEvidence?.sort()).toEqual(["d1", "e1", "e2", "e3"]);
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

  it("Keep from the card's own notice keeps the look of the read it answered", async () => {
    db.seed(LOOP_DAYS, `lv:ten_hearth:${NATURAL}:2`, { tenantId: "ten_hearth", d: { c: {}, looks: { "10": worse, "20": { ...worse, look: 20 } } } });
    expect(await keepLook(hearth, { scope: NATURAL }, deps())).toEqual({ ok: true, v: 2 });
    expect((await readBrandPointers(hearth, db)).scopes[NATURAL]).toMatchObject({ keptAt: NOW.toISOString(), keptLook: 20 });
    // A Go back or an Undo starts a new version, with nothing kept.
    await undoLook(hearth, NATURAL, deps());
    const p = (await readBrandPointers(hearth, db)).scopes[NATURAL];
    expect(p?.keptAt).toBeUndefined();
    expect(p?.keptLook).toBeUndefined();
  });

  it("answers a card still open from the card's own notice, on a copy without Review", async () => {
    const id = await card();
    db.seed(LOOP_DAYS, `lv:ten_hearth:${NATURAL}:2`, { tenantId: "ten_hearth", d: { c: {}, looks: { "10": worse } } });
    expect(await goBackLook(hearth, { scope: NATURAL }, deps())).toMatchObject({ ok: true, v: 3, restored: 1 });
    expect((await getAgentAction(hearth, id as never, { db }))?.state).toBe("acted");
    expect(await listOpenAgentActions(hearth, { action: GO_BACK_ACTION, now: NOW.toISOString(), db })).toEqual([]);
  });

  it("Go back writes the named version's look again, counts reversed and acts on the card", async () => {
    const id = await card();
    expect(await goBackLook(hearth, { cardId: id }, deps())).toEqual({ ok: true, v: 3, restored: 1, restoredAt: V1_AT, wasPerson: false });
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
