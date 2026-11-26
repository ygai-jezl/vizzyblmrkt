import { describe, expect, it } from "vitest";
import { DEFAULT_FUNNEL, type ContentSlot, type ContentPillar } from "@/lib/types/contentStrategy";
import { makeRoadmap, stagesByNeed, weeksFrom, type RoadmapInput } from "./roadmap";
import { scoreSlots, slotWhy } from "./scores";

type Slot = RoadmapInput["slots"][number];

function slot(id: string, over: Partial<ContentSlot> = {}): Slot & Pick<ContentSlot, "facts"> {
  return {
    id,
    questionIds: [`q_${id.slice(4)}`],
    stage: "learn",
    kind: "guide",
    pillarId: "pil_aaaaaa01",
    coveredBy: [],
    inProgress: false,
    hub: false,
    scores: { fit: 0, demand: 0, gap: 0, depth: 0, balance: 0, total: 50 },
    facts: { focus: 0, impressions: null, paa: null, theirs: 0, serp: null },
    ...over,
  };
}
const pillar = (id: string, hub: ContentPillar["hub"] = null) => ({ id, hub });
const NOW = new Date("2026-11-26T10:00:00.000Z");

describe("the weeks", () => {
  it("are 12 ISO weeks from the one today falls in", () => {
    const w = weeksFrom(NOW);
    expect(w).toHaveLength(12);
    expect(w[0]).toEqual({ week: "2026-W48", monday: "2026-11-23" });
    expect(w[5]!.week).toBe("2026-W53");
    expect(w[6]!.week).toBe("2027-W01");
  });
});

describe("the roadmap", () => {
  const weeks = weeksFrom(NOW);
  const base: Omit<RoadmapInput, "slots" | "pillars"> = { weeks, perWeek: 1, funnel: DEFAULT_FUNNEL, refreshShare: 0 };

  it("writes the focus pillar's hub first, then its best slots", () => {
    const slots = [slot("slt_aaaaaa01", { scores: { ...slot("x").scores, total: 90 } }), slot("slt_aaaaaa02", { scores: { ...slot("x").scores, total: 10 } }), slot("slt_aaaaaa03", { scores: { ...slot("x").scores, total: 60 } })];
    const { roadmap, blocks } = makeRoadmap({ ...base, slots, pillars: [pillar("pil_aaaaaa01", { kind: "slot", slotId: "slt_aaaaaa02" })] });
    expect(roadmap.slice(0, 3).map((e) => e.slotId)).toEqual(["slt_aaaaaa02", "slt_aaaaaa01", "slt_aaaaaa03"]);
    expect(roadmap[0]).toEqual({ week: "2026-W48", slotId: "slt_aaaaaa02", action: "write" });
    expect(blocks.map((b) => b.month)).toEqual(["2026-11", "2026-12", "2027-01"]);
  });

  it("keeps the funnel mix: half learn, then consider, then choose", () => {
    const slots = [
      ...Array.from({ length: 6 }, (_, i) => slot(`slt_learn0${i}`, { stage: "learn" })),
      ...Array.from({ length: 6 }, (_, i) => slot(`slt_cons0${i}`, { stage: "consider" })),
      ...Array.from({ length: 6 }, (_, i) => slot(`slt_choo0${i}`, { stage: "choose" })),
    ];
    const { roadmap } = makeRoadmap({ ...base, slots, pillars: [pillar("pil_aaaaaa01")] });
    const stage = new Map(slots.map((s) => [s.id, s.stage] as const));
    const mix = roadmap.map((e) => stage.get(e.slotId)!);
    expect(mix.filter((s) => s === "learn")).toHaveLength(6);
    expect(mix.filter((s) => s === "consider")).toHaveLength(4);
    expect(mix.filter((s) => s === "choose")).toHaveLength(2);
    expect(mix.slice(0, 4)).toEqual(["learn", "consider", "choose", "learn"]);
    expect(stagesByNeed({ learn: 0, consider: 0, choose: 0 }, DEFAULT_FUNNEL)[0]).toBe("learn");
  });

  it("fills perWeek entries a week, one per slot, and never a tool page, a video, one in progress or one skipped", () => {
    const slots = [
      ...Array.from({ length: 30 }, (_, i) => slot(`slt_open${String(i).padStart(2, "0")}`)),
      slot("slt_tool0001", { kind: "tool", scores: { ...slot("x").scores, total: 99 } }),
      slot("slt_video001", { kind: "video", scores: { ...slot("x").scores, total: 99 } }),
      slot("slt_busy0001", { inProgress: true, scores: { ...slot("x").scores, total: 99 } }),
      slot("slt_skip0001", { scores: { ...slot("x").scores, total: 99 } }),
    ];
    const { roadmap } = makeRoadmap({ ...base, perWeek: 2, slots, pillars: [pillar("pil_aaaaaa01")], skipped: new Set(["q_skip0001"]) });
    expect(roadmap).toHaveLength(24);
    expect(roadmap.filter((e) => e.week === "2026-W48")).toHaveLength(2);
    expect(new Set(roadmap.map((e) => e.slotId)).size).toBe(24);
    for (const id of ["slt_tool0001", "slt_video001", "slt_busy0001", "slt_skip0001"]) expect(roadmap.some((e) => e.slotId === id)).toBe(false);
  });

  it("gives the refresh share to combines first, then due refreshes, then other refreshes", () => {
    const slots = [
      ...Array.from({ length: 12 }, (_, i) => slot(`slt_open${String(i).padStart(2, "0")}`)),
      slot("slt_refr0001", { kind: "refresh", coveredBy: ["p_plan1"] }),
      slot("slt_refr0002", { kind: "refresh", coveredBy: ["p_plan2"] }),
      slot("slt_comb0001", { kind: "combine", coveredBy: ["p_plan3", "p_plan4"] }),
      slot("slt_comb0002", { kind: "combine", coveredBy: ["p_plan5", "p_plan6"] }),
    ];
    const { roadmap } = makeRoadmap({
      ...base,
      refreshShare: 1 / 3,
      slots,
      pillars: [pillar("pil_aaaaaa01")],
      duePageIds: ["p_plan2"],
      repeatSlotIds: new Set(["slt_comb0002"]),
    });
    const fixes = roadmap.filter((e) => e.action !== "write");
    expect(fixes.map((e) => `${e.action} ${e.slotId}`)).toEqual(["combine slt_comb0002", "combine slt_comb0001", "refresh slt_refr0002", "refresh slt_refr0001"]);
    // About one entry in three, the first one first.
    expect(roadmap[0]!.action).toBe("combine");
    expect(roadmap.slice(0, 6).filter((e) => e.action !== "write")).toHaveLength(2);
  });

  it("gives two focus pillars a block when the plan has more than 3, the strongest first", () => {
    const pillars = ["pil_aaaaaa01", "pil_aaaaaa02", "pil_aaaaaa03", "pil_aaaaaa04"].map((id) => pillar(id));
    const slots = pillars.flatMap((p, k) => Array.from({ length: 3 }, (_, i) => slot(`slt_${k}${i}aaaaaa`, { pillarId: p.id, scores: { ...slot("x").scores, total: 10 * (k + 1) } })));
    const { blocks } = makeRoadmap({ ...base, slots, pillars });
    expect(blocks.map((b) => b.pillarIds)).toEqual([
      ["pil_aaaaaa04", "pil_aaaaaa03"],
      ["pil_aaaaaa02", "pil_aaaaaa01"],
      ["pil_aaaaaa04", "pil_aaaaaa03"],
    ]);
  });
});

describe("the scores", () => {
  const scored = (over: Partial<ContentSlot>) => slot("slt_aaaaaa01", over);

  it("takes fit from the questions on the strategy's focus situations", () => {
    const s = scoreSlots([scored({ questionIds: ["q_a", "q_b", "q_c", "q_d"], facts: { focus: 3, impressions: null, paa: null, theirs: 0, serp: null } })], DEFAULT_FUNNEL);
    expect(s.get("slt_aaaaaa01")!.fit).toBe(75);
    const none = scoreSlots([scored({})], DEFAULT_FUNNEL);
    expect(none.get("slt_aaaaaa01")!.fit).toBe(0);
  });

  it("weighs demand against the busiest slot, gap only where nothing live answers it, and depth in a started pillar", () => {
    const slots = [
      slot("slt_aaaaaa01", { facts: { focus: 0, impressions: 1000, paa: null, theirs: 2, serp: null } }),
      slot("slt_aaaaaa02", { facts: { focus: 0, impressions: 30, paa: null, theirs: 2, serp: null }, coveredBy: ["p_plan1"] }),
      slot("slt_aaaaaa03", { facts: { focus: 0, impressions: null, paa: 4, theirs: 0, serp: null } }),
    ];
    const s = scoreSlots(slots, DEFAULT_FUNNEL);
    expect(s.get("slt_aaaaaa01")).toMatchObject({ demand: 100, gap: 70, depth: 33 });
    expect(s.get("slt_aaaaaa02")).toMatchObject({ gap: 0, depth: 0 });
    expect(s.get("slt_aaaaaa02")!.demand).toBeLessThan(60);
    expect(s.get("slt_aaaaaa03")!.demand).toBe(60);
  });

  it("raises the stage the live articles are short of", () => {
    const slots = [slot("slt_aaaaaa01", { stage: "learn", coveredBy: ["p_plan1"] }), slot("slt_aaaaaa02", { stage: "choose" }), slot("slt_aaaaaa03", { stage: "learn" })];
    const s = scoreSlots(slots, DEFAULT_FUNNEL);
    expect(s.get("slt_aaaaaa02")!.balance).toBe(70);
    expect(s.get("slt_aaaaaa03")!.balance).toBe(0);
  });

  it("says why in plain words, from the parts that count", () => {
    const s = { ...slot("slt_aaaaaa01", { questionIds: ["q_a", "q_b"], facts: { focus: 2, impressions: 1200, paa: null, theirs: 3, serp: "same" } }), scores: { fit: 100, demand: 80, gap: 85, depth: 50, balance: 90, total: 80 } };
    expect(slotWhy(s, { name: "Get cited", live: 4 }, DEFAULT_FUNNEL)).toEqual([
      "2 of its 2 questions sit on your focus situations",
      "1,200 Search Console impressions",
      "competitors wrote 3 articles on it in 90 days, and nothing live of yours answers it",
      "it fills Get cited, which has 4 live",
      "you have fewer learn articles than your funnel mix asks for",
      "Google shows the same results for its questions",
    ]);
  });
});
