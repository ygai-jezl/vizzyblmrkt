import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { KnowledgeCollectionLike, TenantContext } from "@/lib/tenant/types";
import { BlogBriefSchema, type ContentPlan } from "@/lib/types/contentPlan";
import { answerQuestion, askQuestions, createNote, listNotes, QUESTION_TITLE } from "@/lib/brandNotes/store";
import { DUP_QUESTION_SIM, matchSeen, uniqueQuestions, type SeenDeps } from "./seen";

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1" };
const plan = { name: "Visibility", scope: { spark: "Weekly is enough for most teams.", topics: [], industryLens: "" } } as unknown as ContentPlan;
const P1 = { ref: "ws1/p1", title: "How often to check" };
const REST = { restDays: 30, maxUses: 3 };
const brief = (over: Record<string, unknown> = {}) =>
  BlogBriefSchema.parse({ primaryQuestion: "How often should you check your AI search visibility?", subjectId: null, ...over });

const cos = (x: number[], y: number[]) => {
  const dot = x.reduce((s, v, i) => s + v * (y[i] ?? 0), 0);
  const n = Math.sqrt(x.reduce((s, v) => s + v * v, 0) * y.reduce((s, v) => s + v * v, 0));
  return n ? dot / n : 0;
};
/** Unit vectors that sit at a chosen similarity to the article's question ([1, 0, …]). */
const at = (sim: number, tilt = 0) => [sim, Math.sqrt(1 - sim * sim) * Math.cos(tilt), Math.sqrt(1 - sim * sim) * Math.sin(tilt), 0, 0, 0, 0, 0, 0, 0, 0, 0];
const QUERY = at(1);
/** Anything else embedded points its own way, unrelated to all the rest. */
const apart = (k: number) => Array.from({ length: 12 }, (_, i) => (i === 3 + (k % 9) ? 1 : 0));

/** Vectors scored by meaning: a search finds its kind's rows by cosine to the query vector. */
function vectorsByMeaning(rows: Array<{ kind: string; ref: string; status: string; embedding: number[] }>): KnowledgeCollectionLike {
  const search = (kind: string | null): KnowledgeCollectionLike => ({
    where: (field, _op, value) => search(field === "kind" ? String(value) : kind),
    findNearest: (opts) => ({
      get: async () => {
        const q = (opts as { queryVector: number[] }).queryVector;
        const docs = rows
          .filter((r) => r.kind === kind)
          .map((r, i) => ({ id: `v${i}`, data: () => ({ tenantId: "ten_A", kind: r.kind, ref: r.ref, status: r.status, _distance: 1 - cos(q, r.embedding) }) }))
          .sort((x, y) => x.data()._distance - y.data()._distance);
        return { empty: docs.length === 0, size: docs.length, docs };
      },
    }),
  });
  return search(null);
}

const CANDIDATES = [
  "When did a monitoring result change what a client published that week?",
  "Which prompt did you stop tracking, and why?",
  "Which prompt did you drop, and what made you decide?",
  "What did a client expect monitoring to show that it couldn't?",
  "When did checking less often miss something that mattered?",
];

function setup(meaning: Record<string, number[]> = {}) {
  const db = new FakeFirestore();
  const rows: Parameters<typeof vectorsByMeaning>[0] = [];
  const generate = vi.fn(async (prompt: string) =>
    prompt.includes("[1]") && !prompt.includes("<open>") ? "[1]: STRONG" : CANDIDATES.map((q) => `ASK: ${q}`).join("\n"),
  );
  let k = 0;
  const deps: SeenDeps & { db: FakeFirestore } = {
    db,
    now: () => new Date("2026-10-29T12:00:00.000Z"),
    embed: vi.fn(async (items: Array<{ content: string; title?: string }>) => items.map((i) => meaning[i.content] ?? apart(k++))),
    query: async () => QUERY,
    vectors: vectorsByMeaning(rows),
    generate,
  };
  return { db, deps, rows, generate };
}

beforeEach(() => {
  for (const v of ["BRAND_NOTES_ENABLED", "BRAND_NOTES_QUESTIONS_ENABLED", "BRAND_NOTES_REST_ENABLED"]) vi.stubEnv(v, "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("every article asks its team for something new, when notes rest after use", () => {
  it("asks three new questions even when a note matched, shown what the brand already has", async () => {
    const { deps, rows, generate } = setup();
    const made = await createNote(A, { text: "A brand dropped out of answers for two weeks.", kind: "tested", subjectIds: [], canName: false }, { source: "typed" }, deps);
    if (!made.ok) throw new Error("not made");
    rows.push({ kind: "note", ref: made.value.id, status: "kept", embedding: at(0.8) });

    const seen = await matchSeen(A, { plan, brief: brief(), brandName: "Acme", article: P1, rest: REST }, deps);
    expect(seen.notes.map((n) => n.id)).toEqual([made.value.id]);
    expect(seen.questions?.map((q) => q.question)).toEqual(CANDIDATES.slice(0, 3));
    expect(seen.asks).toEqual([]);
    const prompt = String(generate.mock.calls.at(-1)![0]);
    expect(prompt).toContain("Write 5 questions");
    expect(prompt).toMatch(/<have>\n- A brand dropped out of answers for two weeks\.\n<\/have>/);
    expect(prompt).toContain("<open>\n(none)\n</open>");
    expect((await listNotes(A, deps)).filter((n) => n.status === "asked")).toHaveLength(3);
  });

  it("drops a question that repeats, by meaning, one asked before or another it wrote, and fills from the spares", async () => {
    const twin = at(0.1, 2);
    const { deps, rows } = setup({ [CANDIDATES[0]!]: at(0.2, 1), [CANDIDATES[1]!]: twin, [CANDIDATES[2]!]: twin });
    const [old] = await askQuestions(A, { questions: ["When did a result make a client change what they published?"], article: { ref: "ws1/p9", title: "Older" } }, deps);
    await answerQuestion(A, old!.id, "In March a client rewrote a pricing page the same week.", {}, deps);
    rows.push({ kind: "question", ref: old!.id, status: "answered", embedding: at(0.2, 1) });

    const seen = await matchSeen(A, { plan, brief: brief(), brandName: "Acme", article: P1, rest: REST }, deps);
    expect(seen.questions?.map((q) => q.question)).toEqual([CANDIDATES[1], CANDIDATES[3], CANDIDATES[4]]);
  });

  it("doesn't offer again an open question already asked for as many articles as a note may go into", async () => {
    const { deps, rows, generate } = setup();
    const [busy, quiet] = await askQuestions(
      A,
      { questions: ["Which change was worth catching the same day?", "What did daily checks cost you?"], article: { ref: "ws1/p7", title: "Seven" } },
      deps,
    );
    await forTenant(A, deps.db).brandNotes.update(busy!.id, {
      askedFor: ["ws1/p7", "ws1/p8", "ws1/p9"].map((ref) => ({ ref, title: ref })),
    });
    rows.push({ kind: "question", ref: busy!.id, status: "asked", embedding: at(0.7) }, { kind: "question", ref: quiet!.id, status: "asked", embedding: at(0.6) });
    await matchSeen(A, { plan, brief: brief(), brandName: "Acme", article: P1, rest: REST }, deps);
    const prompt = String(generate.mock.calls.at(-1)![0]);
    expect(prompt).toContain("<open>\n[1] What did daily checks cost you?\n</open>");
    expect(prompt).toContain("- Asked already: Which change was worth catching the same day?");
  });

  it("asks nothing new on Look again", async () => {
    const { deps, generate } = setup();
    const first = await matchSeen(A, { plan, brief: brief(), brandName: "Acme", article: P1, rest: REST }, deps);
    const calls = generate.mock.calls.length;
    const again = await matchSeen(A, { plan, brief: brief({ seen: first }), brandName: "Acme", article: P1, rest: REST }, deps);
    expect(again.questions).toEqual(first.questions);
    expect(generate.mock.calls.length).toBe(calls);
  });
});

describe("uniqueQuestions", () => {
  it("keeps the first ones when embeddings are down, and saves their vectors with them otherwise", async () => {
    const { deps } = setup();
    expect(await uniqueQuestions(A, CANDIDATES, 2, { ...deps, embed: vi.fn(async () => Promise.reject(new Error("down"))) })).toEqual({
      questions: CANDIDATES.slice(0, 2),
      vectors: null,
    });
    const r = await uniqueQuestions(A, CANDIDATES, 3, deps);
    expect(r.questions).toEqual(CANDIDATES.slice(0, 3));
    expect(r.vectors).toHaveLength(3);
    expect(deps.embed).toHaveBeenLastCalledWith(CANDIDATES.map((content) => ({ content, title: QUESTION_TITLE })), "us");
  });

  it("treats two questions as the same from the cutoff up, and keeps them apart below it", async () => {
    const near = (sim: number) => at(sim);
    const { deps } = setup({ a: near(1), b: near(DUP_QUESTION_SIM + 0.001), c: near(DUP_QUESTION_SIM - 0.05) });
    expect((await uniqueQuestions(A, ["a", "b", "c"], 3, deps)).questions).toEqual(["a", "c"]);
  });
});
