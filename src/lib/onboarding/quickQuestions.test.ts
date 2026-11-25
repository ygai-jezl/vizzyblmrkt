import { describe, expect, it } from "vitest";
import { finishBody, optionForKey, pick, questionsView } from "./quickQuestions";
import { FRAME_WORDS, QUESTIONS_WORDS, WELCOME_WORDS } from "./words";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";

describe("the 4 quick questions", () => {
  it("start on the first question with nothing picked, Back going to the welcome", () => {
    const v = questionsView(0, {});
    expect(v).toMatchObject({ done: false, progress: "1 of 4", segments: ["now", "next", "next", "next"], soFar: [], backToWelcome: true });
    expect(v.question.q).toBe("Who are you?");
    expect(v.question.options.map((o) => o.label)).toEqual(["A solo founder", "A small team", "An agency, for clients"]);
  });

  it("show the answers so far under the progress, in question order", () => {
    const v = questionsView(2, { run: "shop", who: "team" });
    expect(v).toMatchObject({ progress: "3 of 4", segments: ["done", "done", "now", "next"], soFar: ["A small team", "A shop or products"], backToWelcome: false });
    expect(v.question.q).toBe("Where is it today?");
  });

  it("a pick moves straight on and saves that one answer, except the last, which the summary saves", () => {
    const one = pick(0, {}, 1)!;
    expect(one).toEqual({ picked: { who: "team" }, at: 1, save: { who: "team" } });
    const last = pick(3, { who: "team" }, 2)!;
    expect(last).toEqual({ picked: { who: "team", want: "customers" }, at: 4, save: null });
    expect(pick(4, {}, 0)).toBeNull();
    expect(pick(0, {}, 3)).toBeNull();
  });

  it("changing an answer after Back replaces it", () => {
    const again = pick(0, { who: "team", run: "app" }, 0)!;
    expect(again.picked).toEqual({ who: "solo", run: "app" });
    expect(again.save).toEqual({ who: "solo" });
  });

  it("pick with the keys 1 to 3 only", () => {
    expect(["1", "2", "3", "4", "0", "a", "Enter"].map(optionForKey)).toEqual([0, 1, 2, null, null, null, null]);
  });

  it("end on That's all four: each answer, or the skipped ones by name, and save them all with done", () => {
    const v = questionsView(4, { who: "solo", stage: "idea", want: "waitlist" });
    expect(v.done).toBe(true);
    expect(v.summary).toEqual([
      { label: "A solo founder", answered: true },
      { label: "What you run: skipped", answered: false },
      { label: "Still an idea", answered: true },
      { label: "Test demand and a waitlist", answered: true },
    ]);
    expect(finishBody({ who: "solo", stage: "idea" })).toEqual({ answers: { who: "solo", stage: "idea" }, status: "done", via: "questions" });
    expect(finishBody({})).toEqual({ status: "done", via: "questions" });
  });
});

describe("the welcome's words", () => {
  it("keep to house style", () => {
    const fns = [WELCOME_WORDS.lead("Example Co"), QUESTIONS_WORDS.progress(1, 4), QUESTIONS_WORDS.skipped("Who you are")];
    const all = [FRAME_WORDS, WELCOME_WORDS, QUESTIONS_WORDS].flatMap((w) => Object.values(w).filter((v): v is string => typeof v === "string"));
    for (const line of [...all, ...fns]) {
      expect(dashesIn(line), line).toEqual([]);
      expect(aiTellsIn(line), line).toEqual([]);
    }
    expect(WELCOME_WORDS.lead("Example Co")).toBe("Tell me about Example Co and I'll suggest your first steps.");
  });
});
