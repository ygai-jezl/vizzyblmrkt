import { describe, it, expect } from "vitest";
import { composePrompt } from "./compose";

describe("composePrompt", () => {
  it("orders sections canonically and skips empties", () => {
    const out = composePrompt({
      task: "TASK",
      identity: "ID",
      constraints: "  ",
      communication: "RULES",
    });
    expect(out).toBe("ID\n\nRULES\n\nTASK");
  });

  it("returns just the task when nothing else is set", () => {
    expect(composePrompt({ task: "only" })).toBe("only");
  });

  it("is empty when all sections are blank", () => {
    expect(composePrompt({ identity: "", task: undefined })).toBe("");
  });
});
