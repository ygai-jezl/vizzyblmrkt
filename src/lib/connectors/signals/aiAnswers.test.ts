import { afterEach, describe, expect, it, vi } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant, type TenantContext } from "@/lib/tenant";
import { nextUpDocId } from "@/lib/types/autopilot";
import { aiAnswersLine, matchPrompt, readAiAnswers, type MonitoredPrompt } from "./aiAnswers";
import { AI_ANSWERS_CHIP, dropAiAnswersPicks } from "./aiAnswersPicks";

// AI answers for Next up (ADR-0019). Every prompt and number is made up.
const A: TenantContext = { tenantId: "ten_a", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
afterEach(() => vi.unstubAllEnvs());

const prompt = (text: string, m: MonitoredPrompt["m"]): MonitoredPrompt => ({ text, m });
const PROMPTS = [
  prompt("best geo tools for agencies", { promptEngines: 6, promptBrandMentions: 0, promptCompetitors: 4, promptCitations: 30 }),
  prompt("how to track brand mentions in chatgpt", { promptEngines: 3, promptBrandMentions: 12, promptCompetitors: 2, promptCitations: 9 }),
  prompt("pricing of ai visibility tools", { promptEngines: 1, promptBrandMentions: 1, promptCompetitors: 1, promptCitations: 1 }),
];

describe("matching a question to a monitored prompt", () => {
  it("takes the same words first, then the one close in wording, never one that only shares a word", () => {
    expect(matchPrompt("Best GEO tools for agencies?", PROMPTS)?.text).toBe("best geo tools for agencies");
    expect(matchPrompt("Which GEO tools are best for agencies", PROMPTS)?.text).toBe("best geo tools for agencies");
    expect(matchPrompt("How do I track brand mentions in ChatGPT?", PROMPTS)?.text).toBe("how to track brand mentions in chatgpt");
    expect(matchPrompt("What do agencies charge for SEO?", PROMPTS)).toBeNull();
    expect(matchPrompt("tools", PROMPTS)).toBeNull();
  });
});

describe("the AI answers line", () => {
  it("says how many engines answer, how often they named the brand and competitors, and the citations, every number in its words", () => {
    const line = aiAnswersLine("Which GEO tools are best for agencies", { prompts: PROMPTS })!;
    expect(line.text).toBe('AI answers: the monitored prompt "best geo tools for agencies" is answered by 6 AI engines, whose answers named you 0 times and 4 competitors, with 30 citations in all.');
    expect(line.chip).toBe('"best geo tools for agencies" answered by 6 engines, you named 0 times');
    expect(line.m).toEqual({ promptEngines: 6, promptBrandMentions: 0, promptCompetitors: 4, promptCitations: 30 });
    expect([...dashesIn(line.text), ...aiTellsIn(line.text), ...dashesIn(line.chip)]).toEqual([]);
    const one = aiAnswersLine("pricing of AI visibility tools", { prompts: PROMPTS })!;
    expect(one.text).toBe('AI answers: the monitored prompt "pricing of ai visibility tools" is answered by 1 AI engine, whose answers named you 1 time and 1 competitor, with 1 citation in all.');
  });

  it("leaves out a number the tool didn't give, never writing it as zero", () => {
    const line = aiAnswersLine("best geo tools for agencies", { prompts: [prompt("best geo tools for agencies", { promptEngines: null, promptBrandMentions: null, promptCompetitors: 2, promptCitations: null })] })!;
    expect(line.text).toBe('AI answers: the monitored prompt "best geo tools for agencies" is monitored in AI answers, whose answers named 2 competitors.');
    expect(line.m).toEqual({ promptCompetitors: 2 });
  });

  it("gives no line without prompts or a close one", () => {
    expect(aiAnswersLine("best geo tools for agencies", null)).toBeNull();
    expect(aiAnswersLine("best geo tools for agencies", { prompts: [] })).toBeNull();
    expect(aiAnswersLine("What do agencies charge for SEO?", { prompts: PROMPTS })).toBeNull();
  });

  it("reads nothing while CONNECTOR_AI_ANSWERS_ENABLED is off", async () => {
    const live = vi.fn();
    expect(await readAiAnswers(A, { db: new FakeFirestore(), live })).toBeNull();
    vi.stubEnv("CONNECTOR_AI_ANSWERS_ENABLED", "true");
    expect(await readAiAnswers(A, { db: new FakeFirestore(), live })).toBeNull();
    vi.stubEnv("CONNECTORS_ENABLED", "true");
    expect(await readAiAnswers(A, { db: new FakeFirestore(), live })).toEqual({ prompts: [] });
    expect(live).not.toHaveBeenCalled();
  });
});

describe("taking off picks that weighed AI answers", () => {
  it("drops only the picks with an AI answers chip", async () => {
    const db = new FakeFirestore();
    const pick = (id: string, label: string) => ({ questionId: id, question: id, subjectId: "sub_a", subjectName: "A", because: "2 of 7 answered.", chips: [{ kind: "num" as const, label, text: "x" }], from: "gemini" as const });
    const doc = { picks: [pick("q_a", AI_ANSWERS_CHIP), pick("q_b", "Brand map")], notOnMap: [], missing: [], candidates: 2, at: "2026-11-21T10:00:00.000Z", by: "person" as const };
    await forTenant(A, db).nextUp.upsert(nextUpDocId(A.tenantId), () => doc, () => doc);
    expect(await dropAiAnswersPicks(A, { db })).toBe(1);
    expect((await forTenant(A, db).nextUp.getById(nextUpDocId(A.tenantId)))!.picks.map((p) => p.questionId)).toEqual(["q_b"]);
    expect(await dropAiAnswersPicks(A, { db })).toBe(0);
  });
});
