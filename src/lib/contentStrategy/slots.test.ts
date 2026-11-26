import { describe, expect, it } from "vitest";
import { BrandMapPageSchema, type BrandMapPage } from "@/lib/types/brandMapPage";
import type { BlogIntent } from "@/lib/types/contentPlan";
import { groupByMeaning, kindOf, makeSlots, questionCoverage, sharedResults, splitBySerp, stageOf, type SlotQuestion } from "./slots";

/**
 * A stub embedder: each question's vector is its ask's direction plus a little of its wording, so
 * rewordings of one ask land close together (above 0.88) and different asks far apart.
 */
const ASKS: Record<string, number[]> = {
  tracking: [1, 0, 0, 0],
  audit: [0, 1, 0, 0],
  llms: [0, 0, 1, 0],
  pricing: [0, 0, 0, 1],
};
const vec = (ask: keyof typeof ASKS, wobble = 0) => ASKS[ask]!.map((x, i) => x + (i === 3 ? wobble : 0) + (i === 0 ? wobble / 2 : 0));

function q(id: string, text: string, over: Partial<SlotQuestion> = {}): SlotQuestion {
  return { id, text, intent: "other", subjectId: "sub_aaaaaa01", focus: false, impressions: null, state: "open", live: [], ...over };
}

const row = (id: string, over: Partial<BrandMapPage> = {}): BrandMapPage =>
  BrandMapPageSchema.parse({ id, tenantId: "ten_A", kind: "article", state: "live", url: `https://a.example.com/${id}`, title: id, liveAt: "2026-11-01T00:00:00.000Z", hash: "h", ...over });

describe("slots: questions merged by meaning", () => {
  const questions = [
    q("q_aaaaaa01", "What is AI search visibility tracking?", { intent: "definition" }),
    q("q_aaaaaa02", "How do you audit your app for AI search?", { intent: "how_to" }),
    q("q_aaaaaa03", "What does AI visibility tracking mean?", { intent: "definition" }),
    q("q_aaaaaa04", "What is llms.txt?", { intent: "definition" }),
    q("q_aaaaaa05", "How can I run a GEO audit before launching?", { intent: "how_to" }),
    q("q_aaaaaa06", "How much does AI visibility tracking cost?", { intent: "pricing" }),
  ];
  const vectors = [vec("tracking"), vec("audit"), vec("tracking", 0.1), vec("llms"), vec("audit", 0.2), vec("pricing")];

  it("groups rewordings of one ask into one slot and keeps different asks apart", () => {
    const { slots } = makeSlots(questions, vectors);
    expect(slots.map((s) => s.questionIds)).toEqual([["q_aaaaaa01", "q_aaaaaa03"], ["q_aaaaaa02", "q_aaaaaa05"], ["q_aaaaaa04"], ["q_aaaaaa06"]]);
    expect(slots[0]!.title).toBe("What is AI search visibility tracking?");
    for (const s of slots) expect(s.id).toMatch(/^slt_[a-z0-9]{6,24}$/);
  });

  it("never chains: a join holds only when every question is close to every other", () => {
    // a~b (0.955) and b~c (0.90), but a and c are far apart (0.73): c stays out.
    const a = [1, 0, 0];
    const b = [0.955, 0.2955, 0];
    const c = [0.7317, 0.6816, 0];
    expect(groupByMeaning(["a", "b", "c"], [a, b, c], { close: 0.88 })).toEqual([[0, 1], [2]]);
  });

  it("with no embedding, groups the same words only", () => {
    const { slots } = makeSlots([q("q_aaaaaa01", "What is GEO?"), q("q_aaaaaa02", "what is GEO"), q("q_aaaaaa03", "What does GEO mean?")], null);
    expect(slots.map((s) => s.questionIds)).toEqual([["q_aaaaaa01", "q_aaaaaa02"], ["q_aaaaaa03"]]);
  });

  it("puts focus questions, then the most searched, first in a slot", () => {
    const { slots } = makeSlots([q("q_aaaaaa01", "One", { impressions: 5 }), q("q_aaaaaa02", "Two", { impressions: 50 }), q("q_aaaaaa03", "Three", { focus: true })], [vec("tracking"), vec("tracking", 0.05), vec("tracking", 0.1)]);
    expect(slots[0]!.questionIds).toEqual(["q_aaaaaa03", "q_aaaaaa02", "q_aaaaaa01"]);
    expect(slots[0]!.facts).toMatchObject({ focus: 1, impressions: 55 });
  });

  it("keeps at most the slot limit, the most focused first, and says how many were left out", () => {
    const many = Array.from({ length: 5 }, (_, i) => q(`q_bbbbbb0${i}`, `Question ${i}`, { focus: i === 4 }));
    const { slots, leftOut } = makeSlots(many, null, { max: 2 });
    expect(slots.map((s) => s.questionIds[0])).toEqual(["q_bbbbbb00", "q_bbbbbb04"]);
    expect(leftOut).toBe(3);
  });
});

describe("slots: stage and kind of page", () => {
  it("reads the stage from the questions' intents", () => {
    const st = (...i: BlogIntent[]) => stageOf(i);
    expect(st("definition")).toBe("learn");
    expect(st("how_to")).toBe("learn");
    expect(st("comparison")).toBe("consider");
    expect(st("alternatives")).toBe("consider");
    expect(st("pricing")).toBe("choose");
    expect(st("pricing", "comparison", "comparison")).toBe("consider");
    expect(st("pricing", "definition")).toBe("choose");
  });

  it("names the kind of page from what is live and the words", () => {
    const k = (texts: string[], over: Partial<Parameters<typeof kindOf>[0]> = {}) => kindOf({ texts, intents: [], live: 0, due: false, open: 1, ...over });
    expect(k(["What is tracking?"], { live: 2 })).toBe("combine");
    expect(k(["What is tracking?"], { live: 1, due: true, open: 0 })).toBe("refresh");
    expect(k(["What is tracking?"], { live: 1, open: 1 })).toBe("refresh");
    expect(k(["What is tracking?"], { live: 1, open: 0 })).toBe("guide");
    expect(k(["Is there a free llms.txt checker?"])).toBe("tool");
    expect(k(["A video on AI visibility"])).toBe("video");
    expect(k(["The best GEO tools in 2026"])).toBe("list");
    expect(kindOf({ texts: ["Which tools do agencies use?"], intents: ["alternatives"], live: 0, due: false, open: 1 })).toBe("list");
    expect(k(["Profound vs Otterly"])).toBe("comparison");
    expect(k(["llms.txt: what it is and how to check yours"])).toBe("guide");
  });
});

describe("slots: covered by a live article", () => {
  const subjects = [
    {
      id: "sub_aaaaaa01",
      name: "Tracking",
      questions: [
        { id: "q_aaaaaa01", text: "What is AI search visibility tracking?", intent: "definition" as const },
        { id: "q_aaaaaa02", text: "How often should teams test prompts?", intent: "how_to" as const, answeredBy: { pageId: "p_plan2" } },
        { id: "q_aaaaaa03", text: "Which engines cite docs?", intent: "other" as const },
        { id: "q_aaaaaa04", text: "Is tracking worth it?", intent: "other" as const },
      ],
    },
  ];
  const rows = [
    row("p_plan1", { primaryRef: "q_aaaaaa01", primaryQuestion: "What is AI search visibility tracking?" }),
    row("p_plan2", { primaryQuestion: "Prompt testing for solo founders" }),
    row("p_plan3", { primaryRef: "q_aaaaaa03", state: "draft", liveAt: null }),
    row("s_site1", { kind: "site", primaryQuestion: "Is tracking worth it?" }),
  ];

  it("counts a live article by the question's id or words, or by Next up's answeredBy link; never a draft or a site page", () => {
    const cov = questionCoverage(subjects, rows);
    expect(cov.get("q_aaaaaa01")).toEqual({ state: "answered", live: ["p_plan1"] });
    expect(cov.get("q_aaaaaa02")).toEqual({ state: "answered", live: ["p_plan2"] });
    expect(cov.get("q_aaaaaa03")).toEqual({ state: "drafted", live: [] });
    expect(cov.get("q_aaaaaa04")).toEqual({ state: "open", live: [] });
  });

  it("a slot two live articles answer is a combine; one with a draft is in progress", () => {
    const cov = questionCoverage(subjects, rows);
    const qs = subjects[0]!.questions.map((x) => q(x.id, x.text, { state: cov.get(x.id)!.state, live: cov.get(x.id)!.live }));
    const { slots } = makeSlots(qs, [vec("tracking"), vec("tracking", 0.1), vec("audit"), vec("llms")]);
    expect(slots[0]).toMatchObject({ questionIds: ["q_aaaaaa01", "q_aaaaaa02"], coveredBy: ["p_plan1", "p_plan2"], kind: "combine" });
    expect(slots[1]).toMatchObject({ coveredBy: [], inProgress: true });
    expect(slots[2]).toMatchObject({ coveredBy: [], inProgress: false });
  });

  it("a slot one live article answers is a refresh when that article is due", () => {
    const { slots } = makeSlots([q("q_aaaaaa01", "What is tracking?", { state: "answered", live: ["p_plan1"] })], null, { duePageIds: new Set(["p_plan1"]) });
    expect(slots[0]!.kind).toBe("refresh");
  });
});

describe("slots: Google's check", () => {
  const tops: Record<string, string[]> = {
    q_aaaaaa01: ["https://a.test/1", "https://a.test/2", "https://a.test/3", "https://a.test/4"],
    q_aaaaaa02: ["https://a.test/1", "https://a.test/2", "https://a.test/3", "https://b.test/9"],
    q_aaaaaa03: ["https://a.test/1", "https://c.test/7", "https://c.test/8"],
  };
  const qs = [q("q_aaaaaa01", "One"), q("q_aaaaaa02", "Two"), q("q_aaaaaa03", "Three"), q("q_aaaaaa04", "Four")];
  const byId = new Map(qs.map((x) => [x.id, x] as const));

  it("keeps questions sharing 3 or more of the top 10 results, and splits one that shares fewer", () => {
    expect(sharedResults(tops.q_aaaaaa01!, tops.q_aaaaaa02!)).toBe(3);
    const { slots } = makeSlots(qs.slice(0, 3), [vec("tracking"), vec("tracking", 0.05), vec("tracking", 0.1)]);
    const { slots: checked, leftOut } = splitBySerp(slots, (id) => tops[id] ?? null, byId);
    expect(leftOut).toBe(0);
    expect(checked.map((s) => [s.questionIds, s.facts.serp])).toEqual([
      [["q_aaaaaa01", "q_aaaaaa02"], "same"],
      [["q_aaaaaa03"], "split"],
    ]);
    expect(checked[0]!.id).toBe(slots[0]!.id);
  });

  it("leaves a slot as meaning grouped it when its questions weren't looked up", () => {
    const { slots } = makeSlots([qs[0]!, qs[3]!], [vec("tracking"), vec("tracking", 0.05)]);
    expect(splitBySerp(slots, (id) => tops[id] ?? null, byId).slots).toEqual(slots);
  });

  it("counts the slots a split pushes past the limit as left out", () => {
    const { slots } = makeSlots(qs.slice(0, 3), [vec("tracking"), vec("tracking", 0.05), vec("tracking", 0.1)]);
    const checked = splitBySerp(slots, (id) => tops[id] ?? null, byId, new Set(), 1);
    expect(checked.slots.map((s) => s.questionIds)).toEqual([["q_aaaaaa01", "q_aaaaaa02"]]);
    expect(checked.leftOut).toBe(1);
  });
});
