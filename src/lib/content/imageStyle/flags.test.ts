import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isBlogHeroEnabled,
  isBlogHeroUiEnabled,
  isBrandImageStyleEnabled,
  isImageFormatsEnabled,
  isImageStyleVersionsOn,
  isMoreStylesEnabled,
  isSiteFontsEnabled,
} from "./flags";

afterEach(() => vi.unstubAllEnvs());

/** The value apphosting.yaml (the public base) gives a variable, or null when it isn't there. */
function valueIn(file: string, variable: string): string | null {
  const text = readFileSync(join(process.cwd(), file), "utf8");
  const m = new RegExp(`- variable: ${variable}\\n\\s+value: "([^"]*)"`).exec(text);
  return m ? m[1]! : null;
}

const SWITCHES = [
  "BRAND_IMAGE_STYLE_ENABLED",
  "NEXT_PUBLIC_BRAND_IMAGE_STYLE_ENABLED",
  "BLOG_HERO_ENABLED",
  "NEXT_PUBLIC_BLOG_HERO_ENABLED",
  "BRAND_IMAGE_STYLE_SITE_FONTS_ENABLED",
  "NEXT_PUBLIC_BRAND_IMAGE_STYLE_SITE_FONTS_ENABLED",
];

describe("the image style switches", () => {
  it("the blog hero needs the image style and the CITABLE blog; site fonts need the image style", () => {
    vi.stubEnv("BLOG_HERO_ENABLED", "true");
    vi.stubEnv("BRAND_IMAGE_STYLE_SITE_FONTS_ENABLED", "true");
    expect([isBrandImageStyleEnabled(), isBlogHeroEnabled(), isSiteFontsEnabled()]).toEqual([false, false, false]);
    vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
    expect([isBlogHeroEnabled(), isSiteFontsEnabled()]).toEqual([false, true]);
    vi.stubEnv("CREATE_BLOG_CITABLE_ENABLED", "true");
    expect(isBlogHeroEnabled()).toBe(true);
  });

  it("the hero's client mirror needs all three client mirrors", () => {
    vi.stubEnv("NEXT_PUBLIC_BLOG_HERO_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_BRAND_IMAGE_STYLE_ENABLED", "true");
    expect(isBlogHeroUiEnabled()).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_BLOG_CITABLE_ENABLED", "true");
    expect(isBlogHeroUiEnabled()).toBe(true);
  });

  it("v2's switches need the image style, and are listed off in the public apphosting.yaml", () => {
    vi.stubEnv("BRAND_IMAGE_STYLE_MORE_ENABLED", "true");
    vi.stubEnv("IMAGE_FORMATS_ENABLED", "true");
    expect([isMoreStylesEnabled(), isImageFormatsEnabled()]).toEqual([false, false]);
    vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
    expect([isMoreStylesEnabled(), isImageFormatsEnabled()]).toEqual([true, true]);
    for (const v of ["BRAND_IMAGE_STYLE_MORE_ENABLED", "NEXT_PUBLIC_BRAND_IMAGE_STYLE_MORE_ENABLED", "IMAGE_FORMATS_ENABLED", "NEXT_PUBLIC_IMAGE_FORMATS_ENABLED"]) {
      expect(valueIn("apphosting.yaml", v), v).toBe("false");
    }
  });

  it("are listed off in the public apphosting.yaml, like every switch", () => {
    for (const v of SWITCHES) {
      expect(valueIn("apphosting.yaml", v), v).toBe("false");
    }
  });

  it("image style versions need learning from image votes and the image style, and are listed off", () => {
    vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "true");
    expect(isImageStyleVersionsOn()).toBe(false);
    vi.stubEnv("BRAND_STYLE_LOOP_ENABLED", "true");
    expect(isImageStyleVersionsOn()).toBe(false);
    vi.stubEnv("BRAND_IMAGE_STYLE_ENABLED", "true");
    expect(isImageStyleVersionsOn()).toBe(true);
    // Only the exact string turns it on.
    vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "TRUE");
    expect(isImageStyleVersionsOn()).toBe(false);
    vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "true");
    vi.stubEnv("BRAND_STYLE_LOOP_ENABLED", "");
    expect(isImageStyleVersionsOn()).toBe(false);
    expect(valueIn("apphosting.yaml", "IMAGE_STYLE_VERSIONS_ENABLED")).toBe("false");
  });
});
