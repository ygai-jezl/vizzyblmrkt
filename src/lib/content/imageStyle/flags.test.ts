import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isBlogHeroEnabled,
  isBlogHeroUiEnabled,
  isBrandImageStyleEnabled,
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

  it("are listed off in the public apphosting.yaml, like every switch", () => {
    for (const v of SWITCHES) {
      expect(valueIn("apphosting.yaml", v), v).toBe("false");
    }
  });
});
