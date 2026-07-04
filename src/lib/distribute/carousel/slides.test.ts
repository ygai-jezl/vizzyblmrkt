import { describe, it, expect } from "vitest";
import { planSlides, slideImagePrompt, MAX_CAROUSEL_SLIDES } from "./slides";

describe("planSlides", () => {
  it("returns no slides for empty body", () => {
    expect(planSlides("")).toEqual({ slides: [], truncated: false });
  });

  it("makes one slide for short single-idea copy", () => {
    const plan = planSlides("One clear idea.");
    expect(plan.slides).toEqual([{ index: 1, text: "One clear idea." }]);
    expect(plan.truncated).toBe(false);
  });

  it("makes one slide per sub-header section (1-based index)", () => {
    const body = "## Hook\nGrab attention.\n\n## Point\nDeliver value.\n\n## Close\nCTA.";
    const plan = planSlides(body);
    expect(plan.slides.map((s) => s.index)).toEqual([1, 2, 3]);
    expect(plan.slides[0]!.text).toBe("Hook\nGrab attention.");
    expect(plan.truncated).toBe(false);
  });

  it("caps at MAX_CAROUSEL_SLIDES and flags truncation", () => {
    const body = Array.from({ length: 15 }, (_, i) => `## S${i}\nbody ${i}`).join("\n\n");
    const plan = planSlides(body);
    expect(plan.slides).toHaveLength(MAX_CAROUSEL_SLIDES);
    expect(plan.truncated).toBe(true);
  });

  it("honours a lower maxSlides but never exceeds the hard cap", () => {
    const body = Array.from({ length: 15 }, (_, i) => `## S${i}\nbody ${i}`).join("\n\n");
    expect(planSlides(body, 3).slides).toHaveLength(3);
    expect(planSlides(body, 999).slides).toHaveLength(MAX_CAROUSEL_SLIDES);
  });
});

describe("slideImagePrompt", () => {
  it("includes the slide text, position, and brand hint", () => {
    const prompt = slideImagePrompt({ index: 2, text: "Be bold." }, 5, { brandHint: "navy + serif" });
    expect(prompt).toContain("Be bold.");
    expect(prompt).toContain("slide 2 of 5");
    expect(prompt).toContain("navy + serif");
  });
});
