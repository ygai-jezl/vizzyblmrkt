import { describe, expect, it } from "vitest";
import { labelsIn } from "./writingRules";

describe("labelsIn: a prompt's own labels written into copy", () => {
  const labels = new Set(["S1", "S2", "S4", "S6", "P3", "C1", "A12"]);

  it("finds the labels the prompt handed over, each once, in order", () => {
    expect(labelsIn("18 live articles across S1, S4, and S6 buying situations", labels)).toEqual(["S1", "S4", "S6"]);
    expect(labelsIn("(S2) and again S2, then A12", labels)).toEqual(["S2", "A12"]);
  });

  it("leaves a token the prompt didn't hand over", () => {
    expect(labelsIn("Backs up to Amazon S3 every night", labels)).toEqual([]);
    expect(labelsIn("Ships on A4 paper", labels)).toEqual([]);
  });

  it("matches whole uppercase tokens only", () => {
    expect(labelsIn("s1 and S1x and XS1 and S10", labels)).toEqual([]);
    expect(labelsIn("K8s clusters, P2P sync, C1C", labels)).toEqual([]);
  });

  it("finds nothing in plain words", () => {
    expect(labelsIn("Publish answers for your focus situations", labels)).toEqual([]);
    expect(labelsIn("", labels)).toEqual([]);
  });
});
