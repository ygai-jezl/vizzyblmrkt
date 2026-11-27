import { describe, expect, it } from "vitest";
import { answeredText } from "./against";

describe("answeredText: the You cell of Against your competitors", () => {
  it("counts the answered questions", () => {
    expect(answeredText({ questions: 9, answered: 1 })).toBe("You: 1 of 9 answered");
    expect(answeredText({ questions: 15, answered: 0 })).toBe("You: 0 of 15 answered");
  });

  it("says a situation has no questions yet, never 0 of 0", () => {
    expect(answeredText({ questions: 0, answered: 0 })).toBe("You: no questions yet");
  });
});
