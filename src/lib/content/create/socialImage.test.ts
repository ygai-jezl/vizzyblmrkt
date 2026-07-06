import { describe, it, expect } from "vitest";
import {
  SOCIAL_ASPECT_TO_GEMINI,
  SOCIAL_ASPECTS,
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
