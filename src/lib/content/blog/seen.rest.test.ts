import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { KnowledgeCollectionLike, TenantContext } from "@/lib/tenant/types";
import { BlogBriefSchema, type ContentPlan } from "@/lib/types/contentPlan";
import type { NoteUse } from "@/lib/types/brandNote";
import { createNote, getNote, markNotesUsed } from "@/lib/brandNotes/store";
import { ADDED_BY_YOU, keepArticleSeen, matchSeen, syncSeenHolds, type SeenDeps } from "./seen";

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1" };
const plan = { name: "Visibility", scope: { spark: "Weekly is enough for most teams.", topics: [], industryLens: "" } } as unknown as ContentPlan;
const P1 = { ref: "ws1/p1", title: "How often to check" };
const P2 = { ref: "ws1/p2", title: "Prompt tracking for agencies" };
const REST = { restDays: 30, maxUses: 3 };
const NOW = new Date("2026-10-29T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const brief = (over: Record<string, unknown> = {}) =>
  BlogBriefSchema.parse({ primaryQuestion: "How often should you check your AI search visibility?", subjectId: null, ...over });

/** A model that rates notes by what they say, and writes three questions when asked for them. */
const model = (verdicts: Record<string, string>) =>
  vi.fn(async (prompt: string) => {
    if (prompt.includes("ASK:")) return "ASK: When have you seen answers change week to week?\nASK: What did daily checks cost you?\nASK: Which change was worth catching the same day?";
    return [...prompt.matchAll(/^\[(\d+)\] (.+)$/gm)]
      .map(([, n, text]) => `[${n}]: ${Object.entries(verdicts).find(([k]) => text!.includes(k))?.[1] ?? "NO"}`)
      .join("\n");
  });

async function setup() {
  const db = new FakeFirestore();
  const rows: Array<{ kind: string; ref: string; status: string }> = [];
  const vectors: KnowledgeCollectionLike = {
    where: () => vectors,
    findNearest: () => ({
      get: async () => ({ empty: rows.length === 0, size: rows.length, docs: rows.map((r, i) => ({ id: `v${i}`, data: () => ({ tenantId: "ten_A", _distance: 0.1 + i * 0.01, ...r }) })) }),
    }),
  };
  const deps: SeenDeps & { db: FakeFirestore } = {
    db,
    now: () => NOW,
    embed: vi.fn(async (items: unknown[]) => items.map(() => [0.1])),
    query: async () => [1],
    vectors,
    generate: model({ "dropped out": "STRONG", "competitor's page": "STRONG", "daily for a month": "STRONG", "own name": "WEAK" }),
  };
  const make = async (text: string, uses: NoteUse[] = [], usedBy = uses.filter((u) => u.written).map((u) => u.ref)) => {
    const r = await createNote(A, { text, kind: "tested", subjectIds: [], canName: false }, { source: "typed" }, deps);
    if (!r.ok) throw new Error("not made");
    if (uses.length || usedBy.length) await forTenant(A, db).brandNotes.update(r.value.id, { uses, usedBy });
    rows.push({ kind: "note", ref: r.value.id, status: "kept" });
    return r.value.id;
  };
  return { db, deps, make };
}

beforeEach(() => {
  for (const v of ["BRAND_NOTES_ENABLED", "BRAND_NOTES_QUESTIONS_ENABLED", "BRAND_NOTES_REST_ENABLED"]) vi.stubEnv(v, "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("an article's notes when notes rest after use", () => {
  it("leaves out a note written into another article recently, and shows it apart with why", async () => {
    const { deps, make } = await setup();
    const fresh = await make("A brand dropped out of answers for two weeks.", [{ ref: "ws1/old", title: "Old one", at: daysAgo(41), written: true }]);
    const recent = await make("A client's share of voice jumped after a competitor's page went offline.", [{ ...P2, at: daysAgo(6), written: true }]);
    const weakResting = await make("Teams track their own name only.", [{ ...P2, at: daysAgo(6), written: true }]);
    const seen = await matchSeen(A, { plan, brief: brief(), brandName: "Acme", article: P1, rest: REST }, deps);

    expect(seen.notes.map((n) => [n.id, n.usedIn, n.lastUsedAt])).toEqual([[fresh, 1, daysAgo(41)]]);
    expect(seen.resting).toEqual([
      expect.objectContaining({ id: recent, reason: "recent", byTitle: P2.title, byAt: daysAgo(6), until: daysAgo(-24), usedIn: 1 }),
    ]);
    // A resting note that only touches the subject is neither offered nor put in.
    expect([...seen.near, ...(seen.resting ?? [])].map((n) => n.id)).not.toContain(weakResting);
  });

  it("leaves out a note used in enough articles, counting the ones from before dates were kept", async () => {
    const { deps, make } = await setup();
    const used = await make("We checked daily for a month and stopped reading the results.", [], ["ws1/a", "ws1/b", "ws1/c"]);
    const seen = await matchSeen(A, { plan, brief: brief(), brandName: "Acme", article: P1, rest: REST }, deps);
    expect(seen.notes).toEqual([]);
    expect(seen.resting).toEqual([expect.objectContaining({ id: used, reason: "used_up", usedIn: 3, until: null })]);
    expect((await matchSeen(A, { plan, brief: brief(), brandName: "Acme", article: P1, rest: { ...REST, maxUses: 4 } }, deps)).notes.map((n) => n.id)).toEqual([used]);
  });

  it("holds the notes it put in, so a second draft leaves them alone, while Look again keeps them", async () => {
    const { deps, make } = await setup();
    const id = await make("A brand dropped out of answers for two weeks.");
    const first = await matchSeen(A, { plan, brief: brief(), brandName: "Acme", article: P1, rest: REST }, deps);
    expect(first.notes.map((n) => n.id)).toEqual([id]);
    expect((await getNote(A, id, deps))?.uses).toEqual([expect.objectContaining({ ref: P1.ref, written: false })]);

    const other = await matchSeen(A, { plan, brief: brief(), brandName: "Acme", article: P2, rest: REST }, deps);
    expect(other.notes).toEqual([]);
    expect(other.resting).toEqual([expect.objectContaining({ id, reason: "held", byTitle: P1.title })]);

    const again = await matchSeen(A, { plan, brief: brief({ seen: first }), brandName: "Acme", article: P1, rest: REST }, deps);
    expect(again.notes.map((n) => n.id)).toEqual([id]);
  });

  it("lets go of a note a person took out, and keeps holding one a person added though it rests", async () => {
    const { deps, make } = await setup();
    const taken = await make("A brand dropped out of answers for two weeks.");
    const added = await make("Our onboarding call takes twenty minutes.", [{ ...P2, at: daysAgo(2), written: true }]);
    const first = await matchSeen(A, { plan, brief: brief(), brandName: "Acme", article: P1, rest: REST }, deps);
    expect(first.notes.map((n) => n.id)).toEqual([taken]);
    const edited = { ...first, notes: [{ id: added, text: "Our onboarding call takes twenty minutes.", why: ADDED_BY_YOU }], removed: [taken] };
    const again = await matchSeen(A, { plan, brief: brief({ seen: edited }), brandName: "Acme", article: P1, rest: REST }, deps);
    expect(again.notes.map((n) => n.id)).toEqual([added]);
    expect((await getNote(A, taken, deps))?.uses).toEqual([]);
    expect((await getNote(A, added, deps))?.uses?.map((u) => [u.ref, u.written])).toEqual([
      [P2.ref, true],
      [P1.ref, false],
    ]);
  });

  it("dates the uses when the article is written, and the note then rests for others", async () => {
    const { deps, make } = await setup();
    const id = await make("A brand dropped out of answers for two weeks.");
    const seen = await matchSeen(A, { plan, brief: brief(), brandName: "Acme", article: P1, rest: REST }, deps);
    await keepArticleSeen(A, { article: P1.ref, brief: brief({ seen }), used: true, title: P1.title }, deps);
    expect((await getNote(A, id, deps))?.uses).toEqual([{ ...P1, at: NOW.toISOString(), written: true }]);
    const other = await matchSeen(A, { plan, brief: brief(), brandName: "Acme", article: P2, rest: REST }, deps);
    expect(other.resting).toEqual([expect.objectContaining({ id, reason: "recent", byTitle: P1.title })]);
  });

  it("with the switch off, matches as before: nothing rests, nothing is held or dated", async () => {
    vi.stubEnv("BRAND_NOTES_REST_ENABLED", "");
    const { deps, make } = await setup();
    const recent = await make("A client's share of voice jumped after a competitor's page went offline.", [{ ...P2, at: daysAgo(6), written: true }]);
    const seen = await matchSeen(A, { plan, brief: brief({ seen: { resting: [] } }), brandName: "Acme", article: P1, rest: REST }, deps);
    expect(seen.notes.map((n) => n.id)).toEqual([recent]);
    expect(seen.notes[0]).not.toHaveProperty("usedIn");
    expect(seen).not.toHaveProperty("resting");
    await keepArticleSeen(A, { article: P1.ref, brief: brief({ seen }), used: true, title: P1.title }, deps);
    expect((await getNote(A, recent, deps))?.uses).toEqual([{ ...P2, at: daysAgo(6), written: true }]);
    expect((await getNote(A, recent, deps))?.usedBy).toEqual([P2.ref, P1.ref]);
  });

  it("without the brand's setting or the article, nothing rests", async () => {
    const { deps, make } = await setup();
    const recent = await make("A client's share of voice jumped after a competitor's page went offline.", [{ ...P2, at: daysAgo(6), written: true }]);
    expect((await matchSeen(A, { plan, brief: brief(), brandName: "Acme", article: P1 }, deps)).notes.map((n) => n.id)).toEqual([recent]);
    await markNotesUsed(A, [recent], P1.ref, deps);
    expect((await getNote(A, recent, deps))?.uses).toHaveLength(1);
  });
});

describe("holds following what a person does to an article's notes", () => {
  const seenWith = (notes: Array<{ id: string; text: string }>, questions: Array<{ id: string; question: string; answer: string }> = []) =>
    brief({ seen: { notes: notes.map((n) => ({ ...n, why: ADDED_BY_YOU })), questions } });

  it("holds a note a person added though it rests, lets go of one they took out, and everything when the article goes", async () => {
    const { deps, make } = await setup();
    const resting = await make("A client's share of voice jumped after a competitor's page went offline.", [{ ...P2, at: daysAgo(6), written: true }]);
    const other = await make("A brand dropped out of answers for two weeks.");
    const text = "x".repeat(20);

    await syncSeenHolds(A, { article: P1, before: brief(), after: seenWith([{ id: resting, text }, { id: other, text }]) }, deps);
    expect((await getNote(A, resting, deps))?.uses?.map((u) => [u.ref, u.written])).toEqual([[P2.ref, true], [P1.ref, false]]);
    expect((await getNote(A, other, deps))?.uses?.map((u) => u.ref)).toEqual([P1.ref]);

    await syncSeenHolds(A, { article: P1, before: seenWith([{ id: resting, text }, { id: other, text }]), after: seenWith([{ id: other, text }]) }, deps);
    expect((await getNote(A, resting, deps))?.uses?.map((u) => u.ref)).toEqual([P2.ref]);

    await syncSeenHolds(A, { article: P1, before: seenWith([{ id: other, text }]), after: null }, deps);
    expect((await getNote(A, other, deps))?.uses).toEqual([]);
  });

  it("holds a question once its team answers it", async () => {
    const { deps, make } = await setup();
    const id = await make("Answered for this article in the team's own words.");
    const q = { id, question: "What did daily checks cost you?", answer: "" };
    await syncSeenHolds(A, { article: P1, before: seenWith([], [q]), after: seenWith([], [{ ...q, answer: "Two hours a week nobody read." }]) }, deps);
    expect((await getNote(A, id, deps))?.uses?.map((u) => u.ref)).toEqual([P1.ref]);
  });

  it("does nothing with the switch off", async () => {
    vi.stubEnv("BRAND_NOTES_REST_ENABLED", "");
    const { deps, make } = await setup();
    const id = await make("A brand dropped out of answers for two weeks.");
    await syncSeenHolds(A, { article: P1, before: brief(), after: seenWith([{ id, text: "x".repeat(20) }]) }, deps);
    expect((await getNote(A, id, deps))?.uses).toBeUndefined();
  });
});
