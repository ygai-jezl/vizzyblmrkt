import { describe, expect, it } from "vitest";
import { headlineFrom } from "./socialText";

describe("headlineFrom", () => {
  it("takes the first sentence of the first line, without links, tags or emoji", () => {
    expect(headlineFrom("🚀 We cut onboarding to five minutes. Here's how.\n\nMore below #growth")).toBe("We cut onboarding to five minutes.");
    expect(headlineFrom("Read this https://example.com/x by @acme #ai")).toBe("Read this by");
    expect(headlineFrom("\n\n  ")).toBe("");
  });

  it("cuts a long line at a word", () => {
    const out = headlineFrom("word ".repeat(50), 40);
    expect(out.length).toBeLessThanOrEqual(41);
    expect(out.endsWith("…")).toBe(true);
  });
});
