import { describe, expect, it } from "vitest";
import { BrandMapPageSchema, type BrandMapPage } from "@/lib/types/brandMapPage";
import { computeCoverage, matchQuestion } from "./coverage";

const map = {
  subjects: [
    {
      id: "sub_aaaaaaaa",
      name: "Share of voice",
      home: "https://acme.example/share-of-voice",
      questions: [
        { id: "q_aaaaaaaa", text: "What is share of voice?", intent: "definition" as const },
        { id: "q_bbbbbbbb", text: "How is share of voice measured?", intent: "benchmarks" as const },
        { id: "q_cccccccc", text: "Which tools track share of voice in AI answers?", intent: "alternatives" as const },
        { id: "q_dddddddd", text: "What does it cost?", intent: "pricing" as const },
      ],
    },
    { id: "sub_bbbbbbbb", name: "Citations", questions: [{ id: "q_eeeeeeee", text: "Why do AI answers cite some pages?", intent: "other" as const }] },
  ],
};

const row = (id: string, over: Partial<BrandMapPage>): BrandMapPage =>
  BrandMapPageSchema.parse({ id, tenantId: "ten_A", kind: "article", workspaceId: "ws1", planId: id, title: id, state: "draft", ...over });

const A = row("p_a", { state: "live", primaryRef: "q_aaaaaaaa", primaryQuestion: "What's share of voice?", url: "https://acme.example/blog/sov", liveAt: "2026-09-01T00:00:00.000Z", subjectId: "sub_aaaaaaaa" });
const B = row("p_b", { primaryQuestion: "How is share of voice measured?" });
const C = row("p_c", { state: "planned", primaryQuestion: "What tools track AI share of voice?" });
const D = row("p_d", { state: "live", primaryRef: "q_aaaaaaaa", url: "https://acme.example/blog/sov-2", liveAt: "2026-10-01T00:00:00.000Z", links: ["https://acme.example/blog/sov"], subjectId: "sub_aaaaaaaa" });
const E = row("s_e", { kind: "site", workspaceId: null, planId: null, state: "live", url: "https://acme.example/share-of-voice", title: "Share of voice" });

describe("what the brand's pages answer", () => {
  it("counts a page that carries the question's id or its exact words, and only shows close wording", () => {
    expect(matchQuestion(map.subjects[0]!.questions[0]!, A)).toBe("sure");
    expect(matchQuestion(map.subjects[0]!.questions[1]!, B)).toBe("sure");
    expect(matchQuestion(map.subjects[0]!.questions[2]!, C)).toBe("probably");
    expect(matchQuestion(map.subjects[0]!.questions[3]!, C)).toBeNull();
    expect(matchQuestion({ id: "q_zzzzzzzz", text: "x" }, row("p_z", { questions: [{ text: "A section", ref: "q_zzzzzzzz" }] }))).toBe("sure");
  });

  it("gives each question its state and the pages that answer it, furthest along first", () => {
    const c = computeCoverage(map, [A, B, C, D, E]);
    const [sov, citations] = c.subjects;
    expect(sov!.questions.map((q) => q.state)).toEqual(["answered", "drafted", "open", "open"]);
    expect(sov!.questions[0]!.pages.map((p) => p.id)).toEqual(["p_d", "p_a"]);
    expect(sov!.questions[2]!.probably?.id).toBe("p_c");
    expect(sov!.questions[3]!.probably).toBeNull();
    expect(sov!.answered).toBe(1);
    expect(citations!.questions[0]!.state).toBe("open");
    expect(c.answered).toEqual({
      q_aaaaaaaa: { title: "p_d", url: "https://acme.example/blog/sov-2", state: "live" },
      q_bbbbbbbb: { title: "p_b", url: null, state: "draft" },
    });
  });

  it("finds two articles with the same main question", () => {
    expect(computeCoverage(map, [A, B, C, D, E]).overlaps).toEqual([{ question: "What's share of voice?", pages: [expect.objectContaining({ id: "p_d" }), expect.objectContaining({ id: "p_a" })] }]);
    expect(computeCoverage(map, [A, B]).overlaps).toEqual([]);
  });

  it("says which older pages on a subject should link to a newer one", () => {
    const c = computeCoverage(map, [A, B, C, D, E]);
    expect(c.missingLinks.map((m) => `${m.from.id}→${m.to.id}`)).toEqual(["s_e→p_a", "s_e→p_d", "p_a→p_d"]);
    // A page on the site whose links were never read is not said to miss one.
    const unread = computeCoverage(map, [A, D, { ...E, linksKnown: false }]);
    expect(unread.missingLinks.map((m) => `${m.from.id}→${m.to.id}`)).toEqual(["p_a→p_d"]);
  });

  it("gives an article's research the live articles on each subject, newest first", () => {
    expect(computeCoverage(map, [A, B, C, D, E]).siblings).toEqual([
      { subjectId: "sub_aaaaaaaa", title: "p_d", url: "https://acme.example/blog/sov-2" },
      { subjectId: "sub_aaaaaaaa", title: "p_a", url: "https://acme.example/blog/sov" },
    ]);
  });

  it("is all open without pages", () => {
    const c = computeCoverage(map, []);
    expect(c.subjects.flatMap((s) => s.questions.map((q) => q.state))).toEqual(["open", "open", "open", "open", "open"]);
    expect(c).toMatchObject({ overlaps: [], missingLinks: [], answered: {}, siblings: [] });
  });
});
