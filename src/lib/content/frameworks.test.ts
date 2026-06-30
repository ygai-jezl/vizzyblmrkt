import { describe, it, expect } from "vitest";
import { CONTENT_FRAMEWORKS, isFramework, getFramework, DEFAULT_FRAMEWORK } from "./frameworks";

describe("content frameworks", () => {
  it("validates ids + default", () => {
    expect(isFramework("contrarian")).toBe(true);
    expect(isFramework("nope")).toBe(false);
    expect(isFramework(DEFAULT_FRAMEWORK)).toBe(true);
  });

  it("every framework carries at least one input→template example", () => {
    for (const f of CONTENT_FRAMEWORKS) {
      expect(f.examples.length).toBeGreaterThan(0);
      for (const ex of f.examples) {
        expect(ex.input.length).toBeGreaterThan(0);
        expect(ex.template).toMatch(/\{\{/); // a template must contain tokens
      }
    }
  });

  it("covers the key spoke styles", () => {
    const ids = CONTENT_FRAMEWORKS.map((f) => f.id);
    for (const id of ["contrarian", "listicle", "story-pas", "how-to", "hook-body-cta", "case-study"]) {
      expect(ids).toContain(id);
    }
  });

  it("getFramework returns structureHint", () => {
    expect(getFramework("listicle")?.structureHint).toBeTruthy();
  });
});
