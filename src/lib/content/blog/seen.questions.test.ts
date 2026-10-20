import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { KnowledgeCollectionLike, TenantContext } from "@/lib/tenant/types";
import { BlogBriefSchema, type ContentPlan } from "@/lib/types/contentPlan";
import { answerQuestion, askQuestions, createNote, getNote, listNotes, removeNote } from "@/lib/brandNotes/store";
import { keepArticleSeen, matchSeen, parseReuse, refreshAnswers, type SeenDeps } from "./seen";
import { seenBlock } from "./draft";
import { seenNotes } from "./citable";

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1" };
const B: TenantContext = { tenantId: "ten_B", region: "us", source: "idtoken" };
const plan = { name: "Visibility", scope: { spark: "Weekly is enough for most teams.", topics: [], industryLens: "" } } as unknown as ContentPlan;
const article = { ref: "ws1/p1", title: "How often to check" };
const other = { ref: "ws1/p2", title: "Tracking AI referral traffic" };
const brief = (over: Record<string, unknown> = {}) =>
  BlogBriefSchema.parse({ primaryQuestion: "How often should you check your AI search visibility?", subjectId: null, ...over });

const ASKS = "ASK: When have you seen answers change week to week?\nASK: What did daily checks cost you?\nASK: Which change was worth catching the same day?";

/** Vectors by kind: what a search of each kind finds, nearest first. */
function vectorsOf(rows: Array<{ kind: string; ref: string; status: string; tenantId?: string }>): KnowledgeCollectionLike {
  const search = (kind: string | null): KnowledgeCollectionLike => ({
    where: (field, _op, value) => search(field === "kind" ? String(value) : kind),
    findNearest: () => ({
      get: async () => {
        const docs = rows
          .filter((r) => r.kind === kind)
          .map((r, i) => ({ id: `v${i}`, data: () => ({ tenantId: "ten_A", _distance: 0.1 + i * 0.01, ...r }) }));
        return { empty: docs.length === 0, size: docs.length, docs };
      },
    }),
  });
  return search(null);
}

function setup(rows: Parameters<typeof vectorsOf>[0] = []) {
  const db = new FakeFirestore();
  const generate = vi.fn(async (prompt: string) => (prompt.includes("<open>") ? "REUSE: 1\nASK: What did daily checks cost you?\nASK: Which change was worth catching the same day?" : ASKS));
  const deps: SeenDeps & { db: FakeFirestore } = {
    db,
    embed: vi.fn(async (items: unknown[]) => items.map(() => [0.1])),
    query: async () => [1],
    vectors: vectorsOf(rows),
    generate,
  };
  return { db, deps, generate };
}

beforeEach(() => {
  vi.stubEnv("BRAND_NOTES_ENABLED", "true");
  vi.stubEnv("BRAND_NOTES_QUESTIONS_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("an article's questions for its team, kept as open questions", () => {
  it("are kept on What we've seen, linked to the article, when nothing matches", async () => {
    const { deps } = setup();
    const seen = await matchSeen(A, { plan, brief: brief(), brandName: "Acme", article }, deps);
    expect(seen.questions?.map((q) => q.question)).toEqual([
      "When have you seen answers change week to week?",
      "What did daily checks cost you?",
      "Which change was worth catching the same day?",
    ]);
    expect(seen.asks).toEqual(seen.questions?.map((q) => q.question));
    const kept = await listNotes(A, deps);
    expect(kept).toHaveLength(3);
    expect(kept.every((n) => n.status === "asked" && n.source === "question" && n.askedFor?.[0]?.ref === "ws1/p1")).toBe(true);
    expect(await listNotes(B, deps)).toEqual([]);
  });

  it("asks nothing new on Look again, and keeps the answers given", async () => {
    const { deps, generate } = setup();
    const first = await matchSeen(A, { plan, brief: brief(), brandName: "Acme", article }, deps);
    const id = first.questions![0]!.id;
    await answerQuestion(A, id, "In March answers changed three weeks running.", {}, deps);
    const refreshed = await refreshAnswers(A, brief({ seen: first }), deps);
    const again = await matchSeen(A, { plan, brief: refreshed, brandName: "Acme", article }, deps);
    expect(again.questions?.map((q) => q.id)).toEqual(first.questions?.map((q) => q.id));
    expect(again.questions?.[0]?.answer).toBe("In March answers changed three weeks running.");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(await listNotes(A, deps)).toHaveLength(3);
  });

  it("never matches its own answered question back in as a note", async () => {
    const { deps } = setup();
    const first = await matchSeen(A, { plan, brief: brief(), brandName: "Acme", article }, deps);
    const id = first.questions![0]!.id;
    await answerQuestion(A, id, "In March answers changed three weeks running.", {}, deps);
    deps.vectors = vectorsOf([{ kind: "note", ref: id, status: "kept" }]);
    deps.generate = vi.fn(async () => "[1]: STRONG");
    const again = await matchSeen(A, { plan, brief: await refreshAnswers(A, brief({ seen: first }), deps), brandName: "Acme", article }, deps);
    expect(again.notes).toEqual([]);
  });

  it("reuses an open question another article asked when it fits, linking it to this one too", async () => {
    const pre = setup();
    const [open] = await askQuestions(A, { questions: ["When did a weekly check miss a change that mattered?"], article: other }, pre.deps);
    const { deps, generate } = { ...pre, deps: { ...pre.deps, vectors: vectorsOf([{ kind: "question", ref: open!.id, status: "asked" }]) } };
    const seen = await matchSeen(A, { plan, brief: brief(), brandName: "Acme", article }, deps);
    expect(seen.questions?.map((q) => q.question)).toEqual([
      "When did a weekly check miss a change that mattered?",
      "What did daily checks cost you?",
      "Which change was worth catching the same day?",
    ]);
    expect(String(generate.mock.calls[0]![0])).toContain("[1] When did a weekly check miss a change that mattered?");
    expect((await getNote(A, open!.id, deps))?.askedFor).toEqual([other, article]);
    expect(await listNotes(A, deps)).toHaveLength(3);
  });

  it("asks again when the article's question changes, keeping the answered ones", async () => {
    const { deps } = setup();
    const first = await matchSeen(A, { plan, brief: brief(), brandName: "Acme", article }, deps);
    await answerQuestion(A, first.questions![1]!.id, "Daily checks took an hour we never got back.", {}, deps);
    const changed = await refreshAnswers(A, brief({ primaryQuestion: "Is weekly AI visibility tracking enough?", seen: first }), deps);
    const again = await matchSeen(A, { plan, brief: changed, brandName: "Acme", article }, deps);
    expect(again.questions?.[0]).toMatchObject({ id: first.questions![1]!.id, answer: "Daily checks took an hour we never got back." });
    expect(again.questions).toHaveLength(3);
    // The questions it dropped stay on What we've seen, still linked to the article.
    expect(await listNotes(A, deps)).toHaveLength(5);
  });

  it("keeps a brief's questions from before without asking the model", async () => {
    const { deps, generate } = setup();
    const old = brief({ seen: { asks: ["What did daily checks cost you?"], matchedFor: "How often should you check your AI search visibility?" } });
    const seen = await matchSeen(A, { plan, brief: old, brandName: "Acme", article }, deps);
    expect(seen.questions?.map((q) => q.question)).toEqual(["What did daily checks cost you?"]);
    expect(generate).not.toHaveBeenCalled();
  });

  it("is today's behaviour with the switch off: questions asked, none kept", async () => {
    vi.stubEnv("BRAND_NOTES_QUESTIONS_ENABLED", "false");
    const { deps } = setup();
    const seen = await matchSeen(A, { plan, brief: brief(), brandName: "Acme", article }, deps);
    expect(seen.asks).toHaveLength(3);
    expect(seen.questions).toBeUndefined();
    expect(await listNotes(A, deps)).toEqual([]);
  });

  it("reads the reuse lines", () => {
    expect(parseReuse("REUSE: 2\nREUSE: [1]\nREUSE: 2\nREUSE: 9\nASK: something", 3)).toEqual([1, 0]);
  });
});

describe("the answers, when the article is written and checked", () => {
  it("are read live, so one changed or removed on the Brand page wins", async () => {
    const { deps } = setup();
    const [q1, q2] = await askQuestions(A, { questions: ["What did you test first?", "Which rival page beat yours?"], article }, deps);
    const b = brief({ seen: { questions: [{ id: q1!.id, question: q1!.question, answer: "old copy" }, { id: q2!.id, question: q2!.question, answer: "" }] } });
    await answerQuestion(A, q1!.id, "We ran the same question every day for a week.", {}, deps);
    await removeNote(A, q2!.id, deps);
    const live = await refreshAnswers(A, b, deps);
    expect(live.seen?.questions).toEqual([{ id: q1!.id, question: "What did you test first?", answer: "We ran the same question every day for a week." }]);
    expect((await refreshAnswers(B, b, deps)).seen?.questions).toEqual([]);
    vi.stubEnv("BRAND_NOTES_QUESTIONS_ENABLED", "false");
    expect(await refreshAnswers(A, b, deps)).toBe(b);
  });

  it("are given to the writer with their question, count as experience, and are recorded as used", async () => {
    const { deps } = setup();
    const [q] = await askQuestions(A, { questions: ['Which "daily" check paid off?'], article }, deps);
    await answerQuestion(A, q!.id, "Catching a lost citation the same day saved a launch.", {}, deps);
    const b = await refreshAnswers(A, brief({ seen: { questions: [{ id: q!.id, question: q!.question, answer: "" }, { id: "bn_short0000000000", question: "Unanswered?", answer: "Too short" }] } }), deps);
    expect(seenBlock(b)).toContain(`(the team's answer when asked "Which 'daily' check paid off?"; keep every person and company in it anonymous) Catching a lost citation the same day saved a launch.`);
    expect(seenNotes(b)).toEqual(["Catching a lost citation the same day saved a launch."]);
    await keepArticleSeen(A, { article: "ws1/p1", brief: b, used: true }, deps);
    expect((await getNote(A, q!.id, deps))?.usedBy).toEqual(["ws1/p1"]);
    // A question nobody answered gives the writer nothing.
    expect(seenBlock(brief({ seen: { questions: [{ id: q!.id, question: q!.question, answer: "Too short" }] } }))).toContain("Claim no experience of its own");
    const typed = await createNote(A, { text: "A note typed on the page.", kind: "tested", subjectIds: [], canName: false }, { source: "typed" }, deps);
    expect(typed.ok).toBe(true);
  });
});
