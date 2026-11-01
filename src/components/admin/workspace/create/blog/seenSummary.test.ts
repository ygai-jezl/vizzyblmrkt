import { describe, expect, it } from "vitest";
import { BlogSeenSchema } from "@/lib/types/contentPlan";
import { seenSummary } from "./seenSummary";

const note = (id: string) => ({ id, text: "A brand dropped out of answers for two weeks." });
const resting = (id: string) => ({ ...note(id), reason: "recent" });
const q = (id: string, answer = "") => ({ id, question: "What did daily checks cost you?", answer });

describe("what Look now found, with notes resting", () => {
  it("names the notes in, the ones resting and the questions still to answer", () => {
    expect(seenSummary(BlogSeenSchema.parse({ notes: [note("a"), note("b")], resting: [resting("c")], questions: [q("x"), q("y"), q("z", "Two hours a week nobody read.")] }))).toBe(
      "2 of your team's notes fit this question, and 1 more is resting. 2 new questions for your team in What we've seen.",
    );
    expect(seenSummary(BlogSeenSchema.parse({ notes: [note("a")], questions: [q("x")] }))).toBe(
      "One of your team's notes fits this question. 1 new question for your team in What we've seen.",
    );
    expect(seenSummary(BlogSeenSchema.parse({ resting: [resting("c"), resting("d")] }))).toBe("The 2 notes that fit this question are resting.");
    expect(seenSummary(BlogSeenSchema.parse({}))).toBe("None of your team's notes fits this question closely.");
  });
});
