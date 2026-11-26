import { beforeEach, describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import {
  changeNote,
  countRaiseDocs,
  createRaiseDoc,
  deleteRaiseDoc,
  exportRaiseDoc,
  listDecksForSearch,
  listRaiseDocs,
  readRaiseDoc,
  restoreRaiseVersion,
  saveRaiseVersion,
  trimVersions,
  type NewDeck,
} from "./store";
import { ACME, FERNHILL, NOW, preSeedSlides, slide } from "./testing/fixtures";
import { RAISE_DOC_LIMITS, type DeckVersion, type RaiseDoc, type Slide } from "./types";

const at = (min: number) => () => new Date(NOW.getTime() + min * 60_000);
const newDeck = (over: Partial<NewDeck> = {}): NewDeck => ({
  audience: "investor",
  stage: "pre_seed",
  title: "Acme pre-seed",
  slides: preSeedSlides(),
  sources: [{ id: "P1", text: "Acme counts stock for small shops.", label: "brand_map" }],
  outline: "investor_pre_seed",
  by: "vizzy",
  note: "First draft by Vizzy.",
  ...over,
});
const withAi = (slides: Slide[]) => slides.map((s) => ({ ...s, ai: { headline: s.headline, points: s.points, notes: s.notes, at: NOW.toISOString(), prompt: "raise.deck_draft@1" } }));

let db: FakeFirestore;
beforeEach(() => {
  db = new FakeFirestore();
});

async function made(over: Partial<NewDeck> = {}): Promise<RaiseDoc> {
  const r = await createRaiseDoc(ACME, newDeck(over), { db, now: at(0) });
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

describe("the raise_docs store", () => {
  it("creates version 1 with its note and counts, under the trusted brand", async () => {
    const doc = await made();
    expect(doc.id).toMatch(/^rd_[a-z0-9]{12}$/);
    expect(doc).toMatchObject({ tenantId: "ten_acme", version: 1, status: "draft", slideCount: 10, createdBy: "usr_admin", updatedBy: "vizzy" });
    expect(doc.versions).toEqual([{ n: 1, note: "First draft by Vizzy.", by: "vizzy", at: NOW.toISOString(), title: "Acme pre-seed", slides: doc.current.slides }]);
    expect(doc.changes).toEqual([{ n: 1, note: "First draft by Vizzy.", by: "vizzy", at: NOW.toISOString() }]);
    expect(db.raw("raise_docs", doc.id)!.tenantId).toBe("ten_acme");
    expect(await readRaiseDoc(ACME, doc.id, { db })).toEqual(doc);
  });

  it("refuses a 21st deck", async () => {
    for (let i = 0; i < RAISE_DOC_LIMITS.decks; i += 1) db.seed("raise_docs", `rd_seed${String(i).padStart(8, "0")}`, { tenantId: "ten_acme" });
    db.seed("raise_docs", "rd_otherbrand01", { tenantId: "ten_fernhill" });
    expect(await countRaiseDocs(ACME, { db })).toBe(20);
    expect(await createRaiseDoc(ACME, newDeck(), { db })).toEqual({ ok: false, status: 409, error: "deck_limit" });
    expect((await createRaiseDoc(FERNHILL, newDeck({ audience: "lender", stage: "loan", outline: "lender_loan" }), { db })).ok).toBe(true);
  });

  it("saves a change as a new version with a note, written from the change when none is typed", async () => {
    const doc = await made();
    const slides = doc.current.slides.map((s, i) => (i === 2 ? { ...s, headline: "Counts a shop in ten minutes flat" } : i === 4 ? { ...s, notes: "Shops switched to card readers this year." } : s));
    const r = await saveRaiseVersion(ACME, doc.id, { baseVersion: 1, slides, by: "usr_admin" }, { db, now: at(5) });
    expect(r.ok && r.value.saved).toBe(true);
    const saved = (await readRaiseDoc(ACME, doc.id, { db }))!;
    expect(saved.version).toBe(2);
    expect(saved.changes[0]).toEqual({ n: 2, note: "Changed slide 3 headline and slide 5 notes.", by: "usr_admin", at: at(5)().toISOString() });
    expect(saved.versions.map((v) => v.n)).toEqual([1, 2]);
    const typed = await saveRaiseVersion(ACME, doc.id, { baseVersion: 2, title: "Acme seed", slides, note: "Renamed for the seed round", by: "usr_admin" }, { db, now: at(6) });
    expect(typed.ok && typed.value.doc.changes[0]!.note).toBe("Renamed for the seed round");
  });

  it("refuses a save made from an older version, and saves nothing when nothing changed", async () => {
    const doc = await made();
    await saveRaiseVersion(ACME, doc.id, { baseVersion: 1, slides: doc.current.slides.slice(1), by: "usr_admin" }, { db });
    expect(await saveRaiseVersion(ACME, doc.id, { baseVersion: 1, slides: doc.current.slides, by: "usr_member" }, { db })).toEqual({ ok: false, status: 409, error: "stale_version", version: 2 });
    const now = (await readRaiseDoc(ACME, doc.id, { db }))!;
    const same = await saveRaiseVersion(ACME, doc.id, { baseVersion: 2, slides: now.current.slides, by: "usr_admin" }, { db });
    expect(same.ok && same.value.saved).toBe(false);
    expect((await readRaiseDoc(ACME, doc.id, { db }))!.version).toBe(2);
  });

  it("keeps Vizzy's original of each slide through a person's edit", async () => {
    const doc = await made({ slides: withAi(preSeedSlides()) });
    const edited: Slide[] = doc.current.slides.map(({ ai: _ai, ...s }, i) => (i === 1 ? { ...s, headline: "Stock day takes a whole Sunday" } : s));
    // A client trying to write its own original is ignored too.
    edited[2] = { ...edited[2]!, ai: { headline: "forged", points: [], notes: "", at: "", prompt: "x" } };
    const r = await saveRaiseVersion(ACME, doc.id, { baseVersion: 1, slides: edited, by: "usr_admin" }, { db });
    expect(r.ok).toBe(true);
    const saved = (await readRaiseDoc(ACME, doc.id, { db }))!;
    expect(saved.current.slides[1]!.headline).toBe("Stock day takes a whole Sunday");
    expect(saved.current.slides[1]!.ai).toEqual(doc.current.slides[1]!.ai);
    expect(saved.current.slides[2]!.ai).toEqual(doc.current.slides[2]!.ai);
  });

  it("keeps version 1 and the newest 11, and a note for every version", async () => {
    const doc = await made();
    let version = 1;
    for (let i = 0; i < 14; i += 1) {
      const slides = doc.current.slides.map((s, j) => (j === 1 ? { ...s, notes: `Take ${i} of the problem story.` } : s));
      const r = await saveRaiseVersion(ACME, doc.id, { baseVersion: version, slides, by: "usr_admin" }, { db, now: at(i + 1) });
      if (!r.ok) throw new Error(r.error);
      version = r.value.doc.version;
    }
    const saved = (await readRaiseDoc(ACME, doc.id, { db }))!;
    expect(saved.version).toBe(15);
    expect(saved.versions.map((v) => v.n)).toEqual([1, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(saved.changes.map((c) => c.n)).toEqual(Array.from({ length: 15 }, (_, i) => 15 - i));
  });

  it("drops the oldest kept version after version 1 when the deck is over its byte budget", () => {
    const big = (n: number): DeckVersion => ({ n, note: "x", by: "vizzy", at: "", title: "t", slides: [slide({ notes: "a".repeat(1200), headline: "h".repeat(160) })] });
    const versions = Array.from({ length: 12 }, (_, i) => big(i + 1));
    const kept = trimVersions(versions, { padding: "p".repeat(RAISE_DOC_LIMITS.bytes - 9_000) });
    expect(kept[0]!.n).toBe(1);
    expect(kept.at(-1)!.n).toBe(12);
    expect(kept.length).toBeLessThan(12);
    expect(trimVersions(versions).map((v) => v.n)).toEqual(versions.map((v) => v.n));
  });

  it("puts a kept version back as a new version, and refuses one no longer kept", async () => {
    const doc = await made();
    await saveRaiseVersion(ACME, doc.id, { baseVersion: 1, slides: doc.current.slides.slice(0, 5), by: "usr_admin" }, { db });
    const r = await restoreRaiseVersion(ACME, doc.id, { n: 1, baseVersion: 2, by: "usr_admin" }, { db });
    expect(r.ok && r.value.doc).toMatchObject({ version: 3, slideCount: 10, changes: [{ n: 3, note: "Put back version 1." }, { n: 2 }, { n: 1 }] });
    expect(await restoreRaiseVersion(ACME, doc.id, { n: 9, baseVersion: 3, by: "usr_admin" }, { db })).toEqual({ ok: false, status: 404, error: "version_not_kept" });
    expect(await restoreRaiseVersion(ACME, doc.id, { n: 1, baseVersion: 2, by: "usr_admin" }, { db })).toEqual({ ok: false, status: 409, error: "stale_version", version: 3 });
  });

  it("exports the deck with every kept version, and deletes it whole", async () => {
    const doc = await made();
    await saveRaiseVersion(ACME, doc.id, { baseVersion: 1, slides: doc.current.slides.slice(0, 9), by: "usr_admin" }, { db });
    const out = (await exportRaiseDoc(ACME, doc.id, { db, now: at(9) }))!;
    expect(out.exportedAt).toBe(at(9)().toISOString());
    expect(out.deck.versions.map((v) => v.n)).toEqual([1, 2]);
    expect(out.deck.sources).toEqual(doc.sources);
    expect(Object.keys(out.deck).sort()).toEqual(["audience", "changes", "current", "id", "sources", "stage", "title", "version", "versions"]);
    expect(await deleteRaiseDoc(ACME, doc.id, { db })).toBe(true);
    expect(db.raw("raise_docs", doc.id)).toBeUndefined();
    expect(await deleteRaiseDoc(ACME, doc.id, { db })).toBe(false);
  });

  it("lists through a projection, newest first, and leaves out what it can't read", async () => {
    const first = await made({ title: "First" });
    const second = (await createRaiseDoc(ACME, newDeck({ title: "Second", audience: "lender", stage: "loan", outline: "lender_loan" }), { db, now: at(3) })) as { ok: true; value: RaiseDoc };
    db.seed("raise_docs", "rd_brokenbroken", { tenantId: "ten_acme", title: 7 });
    const list = await listRaiseDocs(ACME, { db });
    expect(list.map((d) => [d.id, d.kindLabel])).toEqual([
      [second.value.id, "Lender pack"],
      [first.id, "Investor deck, pre-seed"],
    ]);
    expect(list[0]).not.toHaveProperty("versions");
    const searchable = await listDecksForSearch(ACME, { db });
    expect(searchable.map((d) => Object.keys(d).sort())).toEqual([
      ["current", "id", "version"],
      ["current", "id", "version"],
    ]);
  });

  it("never reads, changes or deletes another brand's deck", async () => {
    const doc = await made();
    expect(await readRaiseDoc(FERNHILL, doc.id, { db })).toBeNull();
    expect(await listRaiseDocs(FERNHILL, { db })).toEqual([]);
    expect(await saveRaiseVersion(FERNHILL, doc.id, { baseVersion: 1, slides: [], by: "usr_fern" }, { db })).toEqual({ ok: false, status: 404, error: "not_found" });
    expect(await deleteRaiseDoc(FERNHILL, doc.id, { db })).toBe(false);
    expect(await exportRaiseDoc(FERNHILL, doc.id, { db })).toBeNull();
    expect((await readRaiseDoc(ACME, doc.id, { db }))!.version).toBe(1);
  });
});

describe("change notes", () => {
  it("say what was added, removed, moved and renamed", () => {
    const [a, b, c] = [slide(), slide(), slide()];
    expect(changeNote({ title: "x", slides: [a!, b!] }, { title: "y", slides: [a!, b!, c!] })).toBe("Changed the deck name. Added slide 3.");
    expect(changeNote({ title: "x", slides: [a!, b!, c!] }, { title: "x", slides: [a!, c!] })).toBe("Removed slide 2.");
    expect(changeNote({ title: "x", slides: [a!, b!, c!] }, { title: "x", slides: [b!, a!, c!] })).toBe("Moved slides.");
    expect(changeNote({ title: "x", slides: [a!] }, { title: "x", slides: [{ ...a!, layout: "big_number", points: ["One"] }] })).toBe("Changed slide 1 layout and points.");
    expect(changeNote({ title: "x", slides: [a!] }, { title: "x", slides: [a!] })).toBe("Saved with no changes.");
  });
});
