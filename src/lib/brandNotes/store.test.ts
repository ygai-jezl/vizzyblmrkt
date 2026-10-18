import { describe, expect, it, vi } from "vitest";
import { forTenant } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { BRAND_MAP_VECTORS, brandMapVectorDocId } from "@/lib/tenant/brandMapVectors";
import type { KnowledgeCollectionLike, TenantContext } from "@/lib/tenant/types";
import { BRAND_NOTE_LIMITS, type BrandNote, type BrandNoteInput } from "@/lib/types/brandNote";
import {
  createNote,
  getNote,
  listNotes,
  markNotesUsed,
  nearestNotes,
  notesForSubjects,
  removeNote,
  summariseNotes,
  updateNote,
  type NotesDeps,
} from "./store";

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1" };
const B: TenantContext = { tenantId: "ten_B", region: "us", source: "idtoken" };

const note = (over: Partial<BrandNoteInput> = {}): BrandNoteInput => ({
  text: "A software brand dropped out of answers for two weeks after a rival's comparison page.",
  kind: "customer_story",
  subjectIds: [],
  canName: false,
  ...over,
});

function deps(db = new FakeFirestore()): NotesDeps & { db: FakeFirestore; embed: ReturnType<typeof vi.fn> } {
  let t = Date.parse("2026-10-18T09:00:00.000Z");
  return {
    db,
    now: () => new Date((t += 1000)),
    embed: vi.fn(async (items: Array<{ content: string }>) => items.map(() => [0.1, 0.2])),
  };
}

describe("What we've seen: the brand's notes", () => {
  it("are added, listed newest first, changed and removed, each brand only ever seeing its own", async () => {
    const d = deps();
    const first = await createNote(A, note(), { source: "typed" }, d);
    const second = await createNote(A, note({ text: "We ran the same question every day for a week.", kind: "tested" }), { source: "paste" }, d);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value).toMatchObject({ status: "kept", source: "typed", createdBy: "u1", usedBy: [] });
    expect((await listNotes(A, d)).map((n) => n.id)).toEqual([second.value.id, first.value.id]);
    expect(await listNotes(B, d)).toEqual([]);
    expect(await getNote(B, first.value.id, d)).toBeNull();
    expect((await updateNote(B, first.value.id, { kind: "mistake" }, d)).ok).toBe(false);
    expect((await removeNote(B, first.value.id, d)).ok).toBe(false);

    const changed = await updateNote(A, first.value.id, { kind: "mistake", subjectIds: ["s1", "s1"] }, d);
    expect(changed.ok && changed.value).toMatchObject({ kind: "mistake", subjectIds: ["s1"] });
    expect((await removeNote(A, first.value.id, d)).ok).toBe(true);
    expect(d.db.raw(BRAND_MAP_VECTORS, brandMapVectorDocId("ten_A", "note", first.value.id))).toBeUndefined();
    expect((await listNotes(A, d)).map((n) => n.id)).toEqual([second.value.id]);
  });

  it("embeds a note as it is written, and again when its words change or it is kept", async () => {
    const d = deps();
    const made = await createNote(A, note(), { source: "chat", status: "suggested" }, d);
    if (!made.ok) throw new Error("not made");
    const vec = () => d.db.raw(BRAND_MAP_VECTORS, brandMapVectorDocId("ten_A", "note", made.value.id));
    expect(vec()).toMatchObject({ kind: "note", status: "suggested", tenantId: "ten_A" });
    await updateNote(A, made.value.id, { status: "kept" }, d);
    expect(vec()).toMatchObject({ status: "kept" });
    expect(d.embed).toHaveBeenCalledTimes(2);
    await updateNote(A, made.value.id, { canName: true }, d);
    expect(d.embed).toHaveBeenCalledTimes(2);
  });

  it("still saves a note when embeddings are down", async () => {
    const d = { ...deps(), embed: vi.fn(async () => [null]) };
    const made = await createNote(A, note(), { source: "typed" }, d);
    expect(made.ok).toBe(true);
  });

  it("refuses a note past the backstop", async () => {
    const d = deps();
    const notes = forTenant(A, d.db).brandNotes;
    await Promise.all(
      Array.from({ length: BRAND_NOTE_LIMITS.MAX_NOTES }, (_, i) =>
        notes.create(`bn_fill${String(i).padStart(6, "0")}`, { status: "kept" } as never),
      ),
    );
    const r = await createNote(A, note(), { source: "typed" }, d);
    expect(r).toEqual({ ok: false, status: 409, error: "too_many_notes" });
  });

  it("records the articles that used a note, once each", async () => {
    const d = deps();
    const made = await createNote(A, note(), { source: "typed" }, d);
    if (!made.ok) throw new Error("not made");
    await markNotesUsed(A, [made.value.id, made.value.id], "ws1/p1", d);
    await markNotesUsed(A, [made.value.id], "ws1/p1", d);
    await markNotesUsed(A, [made.value.id], "ws1/p2", d);
    expect((await getNote(A, made.value.id, d))?.usedBy).toEqual(["ws1/p1", "ws1/p2"]);
  });

  it("finds kept notes by subject, and by meaning", async () => {
    const d = deps();
    const linked = await createNote(A, note({ subjectIds: ["sub_1"] }), { source: "typed" }, d);
    await createNote(A, note({ subjectIds: ["sub_1"] }), { source: "chat", status: "suggested" }, d);
    await createNote(B, note({ subjectIds: ["sub_1"] }), { source: "typed" }, d);
    if (!linked.ok) throw new Error("not made");
    expect((await notesForSubjects(A, ["sub_1"], d)).map((n) => n.id)).toEqual([linked.value.id]);

    const rows = [
      { tenantId: "ten_A", kind: "note", ref: linked.value.id, status: "kept", _distance: 0.2 },
      { tenantId: "ten_A", kind: "note", ref: "bn_gone00000000", status: "kept", _distance: 0.1 },
    ];
    const vectors: KnowledgeCollectionLike = {
      where: () => vectors,
      findNearest: () => ({ get: async () => ({ empty: false, size: rows.length, docs: rows.map((r, i) => ({ id: `v${i}`, data: () => r })) }) }),
    };
    const near = await nearestNotes(A, "how often to check", { limit: 5 }, { ...d, vectors, query: async () => [1, 0] });
    expect(near.map((n) => [n.note.id, Math.round(n.sim * 10) / 10])).toEqual([[linked.value.id, 0.8]]);
    expect(await nearestNotes(A, "x", { limit: 5 }, { ...d, vectors, query: async () => null })).toEqual([]);
  });

  it("sums up the kept notes by kind and by the subjects they cover", () => {
    const base: Omit<BrandNote, "id" | "text" | "kind" | "subjectIds" | "status"> = {
      tenantId: "t",
      canName: false,
      source: "typed",
      sourceRef: null,
      usedBy: [],
      createdBy: null,
      createdAt: "",
      updatedAt: "",
    };
    const s = summariseNotes([
      { ...base, id: "1", text: "a", kind: "tested", subjectIds: ["s1"], status: "kept" },
      { ...base, id: "2", text: "b", kind: "tested", subjectIds: ["s1", "s2"], status: "kept" },
      { ...base, id: "3", text: "c", kind: "mistake", subjectIds: ["s3"], status: "suggested" },
    ]);
    expect(s).toMatchObject({ total: 3, kept: 2, suggested: 1, subjectIds: ["s1", "s2"] });
    expect(s.kinds).toMatchObject({ tested: 2, mistake: 0, disagree: 0 });
  });
});
