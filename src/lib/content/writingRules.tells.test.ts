import { describe, expect, it } from "vitest";
import { AI_TELLS, NO_DASHES, aiTellsIn } from "./writingRules";

describe("AI tells", () => {
  it("finds whole words and phrases only, each once", () => {
    expect(aiTellsIn("We leverage a robust, seamless stack. Leverage again.")).toEqual(["leverage", "robust", "seamless"]);
    expect(aiTellsIn("In today’s market it's important to note this.")).toEqual(["in today's", "it's important to note"]);
    // Inside another word is not the tell.
    expect(aiTellsIn("Leveraged buyouts and robustness are fine; so is unlocked.")).toEqual([]);
    expect(aiTellsIn("Plain, specific sentences.")).toEqual([]);
  });

  it("holds no dash, so the list can sit in a prompt beside the no-dashes rule", () => {
    expect(AI_TELLS.join(" ")).not.toMatch(/[—–]/);
    expect(NO_DASHES).toContain("em dash");
  });
});
