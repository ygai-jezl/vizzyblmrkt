import { describe, it, expect } from "vitest";
import {
  SOCIAL_ASPECT_TO_GEMINI,
  SOCIAL_ASPECTS,
  SOCIAL_IMAGE_STYLES,
  SOCIAL_IMAGE_STYLE_IDS,
  DEFAULT_SOCIAL_IMAGE_STYLE,
  socialImageStyle,
  defaultAspectForChannel,
  isSocialImageChannel,
} from "./socialImage";

describe("social image aspect mapping", () => {
  it("maps native social ratios to the nearest Gemini-supported ratio", () => {
    expect(SOCIAL_ASPECT_TO_GEMINI["1:1"]).toBe("1:1");
    expect(SOCIAL_ASPECT_TO_GEMINI["4:5"]).toBe("3:4"); // Gemini has no 4:5 — nearest portrait
    expect(SOCIAL_ASPECT_TO_GEMINI["1.91:1"]).toBe("16:9"); // no 1.91:1 — nearest landscape
  });

  it("has a mapping for every operator-facing aspect", () => {
    for (const a of SOCIAL_ASPECTS) expect(SOCIAL_ASPECT_TO_GEMINI[a]).toBeTruthy();
  });

  it("defaults X to landscape and the rest to square", () => {
    expect(defaultAspectForChannel("x")).toBe("1.91:1");
    expect(defaultAspectForChannel("linkedin")).toBe("1:1");
    expect(defaultAspectForChannel("instagram")).toBe("1:1");
  });

  it("gates the control to the social channels only", () => {
    expect(isSocialImageChannel("linkedin")).toBe(true);
    expect(isSocialImageChannel("x")).toBe(true);
    expect(isSocialImageChannel("instagram")).toBe(true);
    expect(isSocialImageChannel("email")).toBe(false);
    expect(isSocialImageChannel("blog")).toBe(false);
    expect(isSocialImageChannel("newsletter")).toBe(false);
  });
});

describe("social image style presets", () => {
  it("every preset has a unique id + non-empty label/keywords/hint", () => {
    const ids = SOCIAL_IMAGE_STYLES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of SOCIAL_IMAGE_STYLES) {
      expect(s.label.trim()).not.toBe("");
      expect(s.keywords.trim()).not.toBe("");
      expect(s.hint.trim()).not.toBe("");
    }
  });

  it("exposes the ids tuple that mirrors the presets (for the route enum)", () => {
    expect([...SOCIAL_IMAGE_STYLE_IDS]).toEqual(SOCIAL_IMAGE_STYLES.map((s) => s.id));
    expect(SOCIAL_IMAGE_STYLE_IDS).toContain(DEFAULT_SOCIAL_IMAGE_STYLE);
  });

  it("looks a preset up by id and falls back on an unknown id", () => {
    expect(socialImageStyle("minimalist").label).toBe("Minimalist & Clean");
    expect(socialImageStyle("minimalist").keywords).toContain("Scandinavian design");
    // Unknown id → first preset (never undefined), so the engine always has keywords.
    expect(socialImageStyle("bogus").id).toBe(SOCIAL_IMAGE_STYLES[0].id);
  });
});
