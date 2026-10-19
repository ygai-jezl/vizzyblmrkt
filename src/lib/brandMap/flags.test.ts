import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isBrandMapImportEnabled, isBrandMapScaleEnabled, isBrandMapSituationAskEnabled, isBrandMapSituationsEnabled } from "./flags";

afterEach(() => vi.unstubAllEnvs());

/** The value apphosting.yaml (the public base) gives a variable, or null when it isn't there. */
function valueIn(file: string, variable: string): string | null {
  const text = readFileSync(join(process.cwd(), file), "utf8");
  const m = new RegExp(`- variable: ${variable}\\n\\s+value: "([^"]*)"`).exec(text);
  return m ? m[1]! : null;
}

describe("the brand map's switches for size, buying situations and research from a PDF", () => {
  it("each needs the map, and situations and imports need the map at any size", () => {
    vi.stubEnv("BRAND_MAP_SCALE_ENABLED", "true");
    vi.stubEnv("BRAND_MAP_SITUATIONS_ENABLED", "true");
    vi.stubEnv("BRAND_MAP_IMPORT_ENABLED", "true");
    expect([isBrandMapScaleEnabled(), isBrandMapSituationsEnabled(), isBrandMapImportEnabled()]).toEqual([false, false, false]);
    vi.stubEnv("BRAND_MAP_ENABLED", "true");
    expect([isBrandMapScaleEnabled(), isBrandMapSituationsEnabled(), isBrandMapImportEnabled()]).toEqual([true, true, true]);
    vi.stubEnv("BRAND_MAP_SCALE_ENABLED", "false");
    expect([isBrandMapScaleEnabled(), isBrandMapSituationsEnabled(), isBrandMapImportEnabled()]).toEqual([false, false, false]);
  });

  it("are listed off in the public apphosting.yaml, like every switch", () => {
    for (const v of ["BRAND_MAP_SCALE_ENABLED", "BRAND_MAP_SITUATIONS_ENABLED", "BRAND_MAP_IMPORT_ENABLED"]) {
      expect(valueIn("apphosting.yaml", v), v).toBe("false");
    }
  });
});

describe("the switch for finding what people in one buying situation ask", () => {
  it("needs buying situations and research", () => {
    vi.stubEnv("BRAND_MAP_SITUATION_ASK_ENABLED", "true");
    vi.stubEnv("BRAND_MAP_ENABLED", "true");
    vi.stubEnv("BRAND_MAP_SCALE_ENABLED", "true");
    vi.stubEnv("BRAND_MAP_SITUATIONS_ENABLED", "true");
    vi.stubEnv("BRAND_MAP_RESEARCH_ENABLED", "false");
    expect(isBrandMapSituationAskEnabled()).toBe(false);
    vi.stubEnv("BRAND_MAP_RESEARCH_ENABLED", "true");
    expect(isBrandMapSituationAskEnabled()).toBe(true);
    vi.stubEnv("BRAND_MAP_SITUATIONS_ENABLED", "false");
    expect(isBrandMapSituationAskEnabled()).toBe(false);
    vi.stubEnv("BRAND_MAP_SITUATIONS_ENABLED", "true");
    vi.stubEnv("BRAND_MAP_SITUATION_ASK_ENABLED", "false");
    expect(isBrandMapSituationAskEnabled()).toBe(false);
  });

  it("is listed off in the public apphosting.yaml, with its help page twin", () => {
    for (const v of ["BRAND_MAP_SITUATION_ASK_ENABLED", "NEXT_PUBLIC_BRAND_MAP_SITUATION_ASK_ENABLED"]) {
      expect(valueIn("apphosting.yaml", v), v).toBe("false");
    }
  });
});
