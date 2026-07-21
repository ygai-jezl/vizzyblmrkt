import { describe, it, expect } from "vitest";
import {
  IMAGE_MODEL_CHOICES,
  IMAGE_MODEL_SLUGS,
  DEFAULT_IMAGE_MODEL_SLUG,
  isImageModelSlug,
  imageModelOverride,
} from "./imageModels";

describe("image model registry", () => {
  it("exposes exactly the two Nano Banana 2 slugs with labels + hints", () => {
    expect(IMAGE_MODEL_SLUGS).toEqual(["lite", "full"]);
    for (const c of IMAGE_MODEL_CHOICES) {
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.hint.length).toBeGreaterThan(0);
    }
  });

  it("ships NO raw model ids to the client (slugs + friendly labels only)", () => {
    // The registry is imported by client components — a `gemini-*`/`imagen-*` id here would be a
    // model-hardcoding-policy violation (the server resolves slugs → ids via resolveImageModel).
    const blob = JSON.stringify(IMAGE_MODEL_CHOICES);
    expect(blob).not.toMatch(/gemini-|imagen-/);
  });

  it("guards unknown values", () => {
    expect(isImageModelSlug("lite")).toBe(true);
    expect(isImageModelSlug("full")).toBe(true);
    expect(isImageModelSlug("gemini-3.1-flash-image")).toBe(false);
    expect(isImageModelSlug(undefined)).toBe(false);
    expect(isImageModelSlug(42)).toBe(false);
  });
});

describe("imageModelOverride", () => {
  it("returns undefined when the selection is the surface default (→ omitted → server auto/default)", () => {
    // This is the crux of the auto-upgrade fix: an unchanged social dropdown must NOT force lite,
    // so the styleRefs lite→full upgrade survives.
    expect(imageModelOverride("lite", "social")).toBeUndefined();
    expect(imageModelOverride("lite", "email")).toBeUndefined();
    expect(imageModelOverride("full", "ebook")).toBeUndefined();
    expect(imageModelOverride("full", "customise")).toBeUndefined();
  });

  it("returns the slug only when the operator changed it from the default", () => {
    expect(imageModelOverride("full", "social")).toBe("full");
    expect(imageModelOverride("full", "email")).toBe("full");
    expect(imageModelOverride("lite", "ebook")).toBe("lite");
    expect(imageModelOverride("lite", "customise")).toBe("lite");
  });

  it("agrees with the per-surface defaults table", () => {
    for (const surface of Object.keys(DEFAULT_IMAGE_MODEL_SLUG) as (keyof typeof DEFAULT_IMAGE_MODEL_SLUG)[]) {
      expect(imageModelOverride(DEFAULT_IMAGE_MODEL_SLUG[surface], surface)).toBeUndefined();
    }
  });
});
