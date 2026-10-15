import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import { BrandMapDecidedSchema, BrandMapStoredSchema, brandMapDocId, isMapSaved } from "@/lib/types/brandMap";
import { ensureMoved } from "./move";
import { decidedBrandMap, fileBrandMapSuggestions, readBrandMap, saveBrandMap } from "./store";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "admin" };
const NOW = Date.parse("2026-10-15T10:00:00.000Z");
const DECIDED = BrandMapDecidedSchema.parse({
  identity: { name: "Acme", site: "https://acme.example" },
  subjects: [
    {
      id: "sub_aaaaaaaa",
      name: "Share of voice",
      home: "https://acme.example/share-of-voice",
      questions: [
        { id: "q_aaaaaaaa", text: "What is share of voice?", intent: "definition" },
        { id: "q_bbbbbbbb", text: "How is it measured?", intent: "benchmarks" },
      ],
    },
    { id: "sub_bbbbbbbb", name: "Citations", questions: [] },
  ],
});

beforeEach(() => {
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_SCALE_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

async function saved(db: FakeFirestore) {
  const r = await saveBrandMap(ctx, { baseRev: 0, decided: DECIDED }, { db, nowMs: NOW });
  expect(r.ok).toBe(true);
}

describe("the move into records", () => {
  it("copies every subject and question with its id, then marks the map — and does nothing the second time", async () => {
    const db = new FakeFirestore();
    await saved(db);
    expect(await ensureMoved(ctx, { db, nowMs: NOW })).toEqual({ ok: true, moved: true, subjects: 2, questions: 2, proposals: 0 });
    const store = brandMapRecords(ctx, db);
    expect(await store.get("sub", "sub_aaaaaaaa")).toMatchObject({
      name: "Share of voice",
      nameKey: "share of voice",
      home: "https://acme.example/share-of-voice",
      urlKey: "https://acme.example/share-of-voice",
      status: "decided",
      from: "move",
      groupId: null,
      order: 0,
    });
    expect(await store.get("q", "q_bbbbbbbb")).toMatchObject({ subjectId: "sub_aaaaaaaa", text: "How is it measured?", textKey: "how is it measured", intent: "benchmarks", order: 1, status: "decided" });
    const read = await readBrandMap(ctx, db);
    expect(read.state === "ok" && read.map.moved).toMatchObject({ at: "2026-10-15T10:00:00.000Z" });
    // The old list stays as it was.
    expect(read.state === "ok" && read.map.subjects).toEqual(DECIDED.subjects);

    const writes = db.writeCountFor("brand_map_subjects", store.docId("sub", "sub_aaaaaaaa"));
    expect(await ensureMoved(ctx, { db, nowMs: NOW + 1000 })).toEqual({ ok: true, moved: false, subjects: 0, questions: 0, proposals: 0 });
    expect(db.writeCountFor("brand_map_subjects", store.docId("sub", "sub_aaaaaaaa"))).toBe(writes);
  });

  it("starts a brand with no map as moved, so records can be added from the start", async () => {
    const db = new FakeFirestore();
    expect(await ensureMoved(ctx, { db, nowMs: NOW })).toMatchObject({ ok: true, moved: true, subjects: 0 });
    const read = await readBrandMap(ctx, db);
    expect(read.state === "ok" && read.map).toMatchObject({ rev: 0, moved: { at: "2026-10-15T10:00:00.000Z" } });
  });

  it("turns waiting suggestions about subjects into proposals", async () => {
    const db = new FakeFirestore();
    await saved(db);
    await fileBrandMapSuggestions(
      ctx,
      {
        from: "research",
        items: [
          { change: { type: "add_subject", name: "Audits" }, reason: "Buyers ask" },
          { change: { type: "add_question", subject: "Share of voice", text: "Which tools track it?", intent: "alternatives" } },
          { change: { type: "add_question", subject: "Prompts", text: "Which prompts matter?", intent: "how_to" } },
          { change: { type: "set_home", target: "subject", name: "Citations", url: "https://acme.example/citations" } },
        ],
      },
      { db, nowMs: NOW },
    );
    const moved = await ensureMoved(ctx, { db, nowMs: NOW });
    expect(moved).toMatchObject({ ok: true, proposals: 4 });
    const store = brandMapRecords(ctx, db);
    const subjects = await store.find("sub");
    expect(subjects.filter((s) => s.status === "proposed").map((s) => s.name).sort()).toEqual(["Audits", "Prompts"]);
    expect(subjects.find((s) => s.name === "Audits")).toMatchObject({ from: "research", reason: "Buyers ask" });
    const questions = await store.find("q", { where: [["status", "==", "proposed"]] });
    expect(questions.map((q) => [q.text, subjects.find((s) => s.id === q.subjectId)?.name]).sort()).toEqual([
      ["Which prompts matter?", "Prompts"],
      ["Which tools track it?", "Share of voice"],
    ]);
    expect(await store.get("sub", "sub_bbbbbbbb")).toMatchObject({ home: null, suggestedHome: "https://acme.example/citations" });
  });

  it("brings in subjects added to the old list while the switch was off, but not a rename made there", async () => {
    const db = new FakeFirestore();
    await saved(db);
    await ensureMoved(ctx, { db, nowMs: NOW });
    // Off: an older build saves the old list with a new subject and a renamed one.
    const raw = db.raw("brand_maps", brandMapDocId("ten_A"))!;
    const subjects = [{ ...DECIDED.subjects[0]!, name: "Voice share" }, DECIDED.subjects[1]!, { id: "sub_cccccccc", name: "Audits", questions: [] }];
    db.seed("brand_maps", brandMapDocId("ten_A"), { ...raw, subjects });
    expect(await ensureMoved(ctx, { db, nowMs: NOW + 5000 })).toMatchObject({ ok: true, moved: true, subjects: 1 });
    const store = brandMapRecords(ctx, db);
    expect((await store.get("sub", "sub_cccccccc"))?.name).toBe("Audits");
    expect((await store.get("sub", "sub_aaaaaaaa"))?.name).toBe("Share of voice");
    expect(await ensureMoved(ctx, { db, nowMs: NOW + 6000 })).toMatchObject({ moved: false });
  });
});

describe("saving a moved map", () => {
  it("keeps the old subjects whatever a save sends, and doesn't check what it doesn't keep", async () => {
    const db = new FakeFirestore();
    await saved(db);
    await ensureMoved(ctx, { db, nowMs: NOW });
    const next = { ...DECIDED, identity: { ...DECIDED.identity, category: "AI visibility tracking" }, subjects: [{ id: "bad id", name: "x" }] };
    const r = await saveBrandMap(ctx, { baseRev: 1, decided: next }, { db, nowMs: NOW + 1000 });
    expect(r.ok && r.value).toMatchObject({ rev: 2, subjects: DECIDED.subjects, identity: { category: "AI visibility tracking" } });
    const again = await saveBrandMap(ctx, { baseRev: 2, decided: { ...next, subjects: [] } }, { db, nowMs: NOW + 2000 });
    expect(again.ok && again.value).toMatchObject({ rev: 2, subjects: DECIDED.subjects });
  });

  it("takes subjects from a save again once the switch is off (it rolls back to the old list)", async () => {
    const db = new FakeFirestore();
    await saved(db);
    await ensureMoved(ctx, { db, nowMs: NOW });
    vi.stubEnv("BRAND_MAP_SCALE_ENABLED", "false");
    const r = await saveBrandMap(ctx, { baseRev: 1, decided: { ...DECIDED, subjects: [DECIDED.subjects[1]!] } }, { db, nowMs: NOW + 1000 });
    expect(r.ok && r.value.subjects.map((s) => s.name)).toEqual(["Citations"]);
  });

  it("is still read by a build that knows nothing of the move", async () => {
    const db = new FakeFirestore();
    await saved(db);
    await ensureMoved(ctx, { db, nowMs: NOW });
    const older = BrandMapStoredSchema.omit({ moved: true, recordsDecidedAt: true });
    // As the tenant layer hands it over: with its document id.
    const stored = { id: brandMapDocId("ten_A"), ...db.raw("brand_maps", brandMapDocId("ten_A")) };
    expect(older.safeParse(stored).success).toBe(true);
  });

  it("counts as saved once a record was decided, even before the page was saved", async () => {
    expect(isMapSaved({ rev: 0, recordsDecidedAt: null })).toBe(false);
    expect(isMapSaved({ rev: 0, recordsDecidedAt: "2026-10-15T10:00:00.000Z" })).toBe(true);
    const db = new FakeFirestore();
    await ensureMoved(ctx, { db, nowMs: NOW });
    expect(await decidedBrandMap(ctx, db)).toBeNull();
    const raw = db.raw("brand_maps", brandMapDocId("ten_A"))!;
    db.seed("brand_maps", brandMapDocId("ten_A"), { ...raw, recordsDecidedAt: "2026-10-15T10:00:00.000Z" });
    expect(await decidedBrandMap(ctx, db)).not.toBeNull();
  });
});
