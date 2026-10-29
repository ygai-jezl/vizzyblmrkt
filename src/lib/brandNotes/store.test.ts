import { describe, expect, it, vi } from "vitest";
import { forTenant } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { BRAND_MAP_VECTORS, brandMapVectorDocId } from "@/lib/tenant/brandMapVectors";
import type { KnowledgeCollectionLike, TenantContext } from "@/lib/tenant/types";
import { BRAND_NOTE_LIMITS, type BrandNote, type BrandNoteInput } from "@/lib/types/brandNote";
import {
  addAskedFor,
  answerQuestion,
  askQuestions,
  createNote,
  getNote,
  holdNotes,
  listNotes,
  markNotesUsed,
  nearestNotes,
  nearestOpenQuestions,
  notesById,
  notesForSubjects,
  QUESTION_HEADROOM,
  releaseHolds,
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
    expect(s).toMatchObject({ total: 3, kept: 2, suggested: 1, asked: 0, subjectIds: ["s1", "s2"] });
    expect(s.kinds).toMatchObject({ tested: 2, mistake: 0, disagree: 0 });
  });

  it("counts open questions apart, and in nothing else", () => {
    const base: Omit<BrandNote, "id" | "text" | "kind" | "subjectIds" | "status" | "source"> = {
      tenantId: "t",
      canName: false,
      sourceRef: null,
      usedBy: [],
      createdBy: null,
      createdAt: "",
      updatedAt: "",
    };
    const s = summariseNotes([
      { ...base, id: "1", text: "a", kind: "tested", subjectIds: ["s1"], status: "kept", source: "typed" },
      { ...base, id: "2", text: "", kind: "tested", subjectIds: ["s2"], status: "asked", source: "question", question: "Which test surprised you?" },
      { ...base, id: "3", text: "c", kind: "mistake", subjectIds: [], status: "suggested", source: "chat" },
    ]);
    expect(s).toMatchObject({ total: 2, kept: 1, suggested: 1, asked: 1, subjectIds: ["s1"] });
    expect(s.kinds.tested).toBe(1);
  });
});

describe("What we've seen: open questions", () => {
  const article = { ref: "ws1/p1", title: "Finding buyer prompts in Search Console" };
  const vec = (d: { db: FakeFirestore }, kind: "note" | "question", id: string) => d.db.raw(BRAND_MAP_VECTORS, brandMapVectorDocId("ten_A", kind, id));

  it("keeps an article's questions as open questions, linked to it, with one embedding call", async () => {
    const d = deps();
    const made = await askQuestions(A, { questions: ["Which test surprised you most?", "  Which test surprised you most? ", "When did a rival's page beat yours?"], article }, d);
    expect(made).toHaveLength(2);
    expect(made[0]).toMatchObject({
      text: "",
      status: "asked",
      source: "question",
      sourceRef: null,
      subjectIds: [],
      question: "Which test surprised you most?",
      askedFor: [article],
      createdBy: "u1",
    });
    expect(d.embed).toHaveBeenCalledTimes(1);
    expect(vec(d, "question", made[0]!.id)).toMatchObject({ kind: "question", status: "asked" });
    expect(vec(d, "note", made[0]!.id)).toBeUndefined();
    expect(await listNotes(B, d)).toEqual([]);
    expect(await notesById(B, [made[0]!.id], d)).toEqual([]);
    expect((await notesById(A, [made[1]!.id, made[0]!.id], d)).map((n) => n.id)).toEqual([made[1]!.id, made[0]!.id]);
  });

  it("keeps no questions when the brand is near its backstop", async () => {
    const d = deps();
    const notes = forTenant(A, d.db).brandNotes;
    await Promise.all(
      Array.from({ length: BRAND_NOTE_LIMITS.MAX_NOTES - QUESTION_HEADROOM }, (_, i) => notes.create(`bn_fill${String(i).padStart(6, "0")}`, { status: "kept" } as never)),
    );
    expect(await askQuestions(A, { questions: ["Which test surprised you most?"], article }, d)).toEqual([]);
  });

  it("links a question to each article that asks it, once", async () => {
    const d = deps();
    const [q] = await askQuestions(A, { questions: ["Which test surprised you most?"], article }, d);
    const other = { ref: "ws1/p2", title: "Tracking AI referral traffic" };
    await addAskedFor(A, q!.id, other, d);
    await addAskedFor(A, q!.id, other, d);
    expect((await getNote(A, q!.id, d))?.askedFor).toEqual([article, other]);
    expect(await addAskedFor(B, q!.id, other, d)).toBeNull();
    const typed = await createNote(A, note(), { source: "typed" }, d);
    if (!typed.ok) throw new Error("not made");
    expect((await addAskedFor(A, typed.value.id, other, d))?.askedFor).toBeUndefined();
  });

  it("becomes a kept note once answered, and an open question again once cleared", async () => {
    const d = deps();
    const [q] = await askQuestions(A, { questions: ["What did you test first?"], article }, d);
    const id = q!.id;

    const short = await answerQuestion(A, id, "We ran", { subjectId: "sub_1" }, d);
    expect(short.ok && short.value).toMatchObject({ status: "asked", text: "We ran", subjectIds: [] });
    expect(d.embed).toHaveBeenCalledTimes(1);

    const answered = await answerQuestion(A, id, "We ran the same question every day for a week.", { subjectId: "sub_1" }, d);
    expect(answered.ok && answered.value).toMatchObject({ status: "kept", kind: "tested", subjectIds: ["sub_1"], answeredBy: "u1" });
    expect(vec(d, "question", id)).toMatchObject({ status: "answered" });
    expect(vec(d, "note", id)).toMatchObject({ status: "kept" });
    expect(d.embed).toHaveBeenCalledTimes(2);
    expect(d.embed.mock.calls[1]![0]).toEqual([{ content: "What did you test first?\nWe ran the same question every day for a week.", title: "What we've seen" }]);

    await answerQuestion(A, id, "We ran the same question every day for a week, twice.", {}, d);
    expect(d.embed).toHaveBeenCalledTimes(2);
    await answerQuestion(A, id, "We ran the same question every day for a week, twice.", { done: true }, d);
    expect(d.embed).toHaveBeenCalledTimes(3);

    const cleared = await answerQuestion(A, id, "  ", {}, d);
    expect(cleared.ok && cleared.value).toMatchObject({ status: "asked", text: "", subjectIds: [] });
    expect(vec(d, "question", id)).toMatchObject({ status: "asked" });
    expect(vec(d, "note", id)).toBeUndefined();

    expect((await answerQuestion(B, id, "We ran the same question every day.", {}, d)).ok).toBe(false);
    const typed = await createNote(A, note(), { source: "typed" }, d);
    if (!typed.ok) throw new Error("not made");
    expect(await answerQuestion(A, typed.value.id, "We ran the same question every day.", {}, d)).toEqual({ ok: false, status: 404, error: "not_found" });
  });

  it("is kept on the page only by answering it, and removed with both of its embeddings", async () => {
    const d = deps();
    const [q] = await askQuestions(A, { questions: ["What did you test first?"], article }, d);
    expect(await updateNote(A, q!.id, { status: "kept" }, d)).toEqual({ ok: false, status: 409, error: "unanswered_question" });
    const kept = await updateNote(A, q!.id, { text: "We ran the same question every day for a week." }, d);
    expect(kept.ok && kept.value).toMatchObject({ status: "kept", answeredBy: "u1" });
    expect(vec(d, "question", q!.id)).toMatchObject({ status: "answered" });
    expect(vec(d, "note", q!.id)).toMatchObject({ status: "kept" });
    expect((await removeNote(A, q!.id, d)).ok).toBe(true);
    expect(vec(d, "question", q!.id)).toBeUndefined();
    expect(vec(d, "note", q!.id)).toBeUndefined();
  });

  it("finds open questions close in meaning, leaving out the ones asked for", async () => {
    const d = deps();
    const [a, b] = await askQuestions(A, { questions: ["What did you test first?", "Which rival page beat yours?"], article }, d);
    await answerQuestion(A, b!.id, "A rival's comparison page outranked ours for a month.", {}, d);
    const rows = [
      { tenantId: "ten_A", kind: "question", ref: a!.id, status: "asked", _distance: 0.1 },
      { tenantId: "ten_A", kind: "question", ref: b!.id, status: "asked", _distance: 0.15 },
      { tenantId: "ten_B", kind: "question", ref: a!.id, status: "asked", _distance: 0.1 },
    ];
    const vectors: KnowledgeCollectionLike = {
      where: () => vectors,
      findNearest: () => ({ get: async () => ({ empty: false, size: rows.length, docs: rows.map((r, i) => ({ id: `v${i}`, data: () => r })) }) }),
    };
    expect((await nearestOpenQuestions(A, [1, 0], { limit: 3 }, { ...d, vectors })).map((n) => n.note.id)).toEqual([a!.id]);
    expect(await nearestOpenQuestions(A, [1, 0], { limit: 3, exclude: [a!.id] }, { ...d, vectors })).toEqual([]);
  });
});

describe("What we've seen: drafts holding notes, and dated uses (BRAND_NOTES_REST_ENABLED)", () => {
  const P1 = { ref: "ws1/p1", title: "How often to check prompts" };
  const P2 = { ref: "ws1/p2", title: "Share of voice for local shops" };
  async function made(d: ReturnType<typeof deps>) {
    const r = await createNote(A, note(), { source: "typed" }, d);
    if (!r.ok) throw new Error("not made");
    return r.value.id;
  }

  it("a draft holds a note, and a second draft is turned away until the first lets it go", async () => {
    const d = deps();
    const id = await made(d);
    expect(await holdNotes(A, [id, id], P1, {}, d)).toEqual([id]);
    expect((await getNote(A, id, d))?.uses).toEqual([expect.objectContaining({ ref: "ws1/p1", title: P1.title, written: false })]);
    expect(await holdNotes(A, [id], P2, {}, d)).toEqual([]);
    // Its own draft taking it again only moves the date.
    expect(await holdNotes(A, [id], P1, {}, d)).toEqual([id]);
    expect((await getNote(A, id, d))?.uses).toHaveLength(1);

    await releaseHolds(A, [id], P1.ref, d);
    expect((await getNote(A, id, d))?.uses).toEqual([]);
    expect(await holdNotes(A, [id], P2, {}, d)).toEqual([id]);
  });

  it("of two drafts taking the same note at once, only one holds it", async () => {
    const d = deps();
    const id = await made(d);
    const [one, two] = await Promise.all([holdNotes(A, [id], P1, {}, d), holdNotes(A, [id], P2, {}, d)]);
    expect([...one, ...two]).toEqual([id]);
    expect((await getNote(A, id, d))?.uses).toHaveLength(1);
  });

  it("a person choosing a resting note holds it anyway", async () => {
    const d = deps();
    const id = await made(d);
    await holdNotes(A, [id], P1, {}, d);
    expect(await holdNotes(A, [id], P2, { force: true }, d)).toEqual([id]);
    expect((await getNote(A, id, d))?.uses?.map((u) => u.ref)).toEqual(["ws1/p1", "ws1/p2"]);
  });

  it("writing the article turns its hold into a dated use that a later check never moves", async () => {
    const d = deps();
    const id = await made(d);
    await holdNotes(A, [id], P1, {}, d);
    await markNotesUsed(A, [id], P1.ref, d, { title: P1.title });
    const first = (await getNote(A, id, d))!;
    expect(first.usedBy).toEqual(["ws1/p1"]);
    expect(first.uses).toEqual([expect.objectContaining({ ref: "ws1/p1", written: true })]);
    await markNotesUsed(A, [id], P1.ref, d, { title: "Renamed" });
    await holdNotes(A, [id], P1, {}, d);
    await releaseHolds(A, [id], P1.ref, d);
    expect((await getNote(A, id, d))?.uses).toEqual(first.uses);
    // Written recently, it rests for other drafts.
    expect(await holdNotes(A, [id], P2, { rest: { restDays: 30 } }, d)).toEqual([]);
    expect(await holdNotes(A, [id], P2, { rest: { restDays: 0 } }, d)).toEqual([id]);
  });

  it("an undated use from before gets its date when the article is checked again", async () => {
    const d = deps();
    const id = await made(d);
    await markNotesUsed(A, [id], P1.ref, d);
    expect((await getNote(A, id, d))?.uses).toBeUndefined();
    await markNotesUsed(A, [id], P1.ref, d, { title: P1.title });
    expect((await getNote(A, id, d))?.uses).toEqual([expect.objectContaining({ ref: "ws1/p1", written: true })]);
    expect((await getNote(A, id, d))?.usedBy).toEqual(["ws1/p1"]);
  });

  it("never holds an open question or another brand's note", async () => {
    const d = deps();
    const id = await made(d);
    const [q] = await askQuestions(A, { questions: ["Which prompt did you stop tracking, and why?"], article: P1 }, d);
    expect(await holdNotes(A, [q!.id], P1, {}, d)).toEqual([]);
    expect(await holdNotes(B, [id], P1, { force: true }, d)).toEqual([]);
    await releaseHolds(B, [id], P1.ref, d);
    await markNotesUsed(B, [id], P1.ref, d, { title: P1.title });
    expect((await getNote(A, id, d))?.uses).toBeUndefined();
  });
});
