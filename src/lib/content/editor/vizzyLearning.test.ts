import { describe, expect, it } from "vitest";
import { LearnRequestSchema, learningEventText, memoryLabel, wordChanges } from "./vizzyLearning";

describe("what goes to Memory Bank", () => {
  it("finds the words taken out and put in", () => {
    expect(
      wordChanges(
        "Most launches slip because the team tries to do everything at once, and in today's world that is a mistake.",
        "Most launches slip because the team tries to do everything at once.",
      ),
    ).toEqual({ removed: ["once, and in today's world that is a mistake."], added: ["once."] });
    expect(wordChanges("Keep the color the same", "Keep the colour the same")).toEqual({ removed: ["color"], added: ["colour"] });
    expect(wordChanges("same words", "same words")).toEqual({ removed: [], added: [] });
  });

  it("writes one line with the request, the changed words and what the person did", () => {
    expect(
      learningEventText({ instruction: "use UK spelling", kind: "whole", outcome: "kept", before: "organize", after: "organise" }),
    ).toBe('I asked Vizzy, across the whole text: "use UK spelling". Vizzy changed "organize" to "organise". I kept the change.');
    expect(
      learningEventText({
        instruction: "make it exciting",
        kind: "selection",
        outcome: "undone",
        before: "A plan for the launch.",
        after: "A revolutionary plan for the launch.",
      }),
    ).toBe('I asked Vizzy, on text I selected: "make it exciting". Vizzy put in "revolutionary". I undid the change.');
  });

  it("sends only the changed words, not the paragraph around them", () => {
    const before = `${"Words that stay the same. ".repeat(8)}Old ending.`;
    const after = `${"Words that stay the same. ".repeat(8)}New ending.`;
    const line = learningEventText({ instruction: "tidy", kind: "selection", outcome: "kept", before, after });
    expect(line).not.toContain("stay the same");
    expect(line).toContain('"Old" to "New"');
  });

  it("caps what a page may send", () => {
    const entry = { instruction: "x", kind: "selection", outcome: "kept", before: "a", after: "b" };
    expect(LearnRequestSchema.safeParse({ entries: Array.from({ length: 21 }, () => entry) }).success).toBe(false);
    expect(LearnRequestSchema.safeParse({ entries: [{ ...entry, before: "x".repeat(281) }] }).success).toBe(false);
    expect(LearnRequestSchema.safeParse({ entries: [entry] }).success).toBe(true);
  });

  it("shows a memory without 'The user'", () => {
    expect(memoryLabel("The user keeps intros short.")).toBe("Keeps intros short.");
    expect(memoryLabel("Uses UK spelling.")).toBe("Uses UK spelling.");
  });
});
