import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isBrandMapImportEnabled, isBrandMapScaleEnabled, isBrandMapSituationsEnabled } from "./flags";

afterEach(() => vi.unstubAllEnvs());

/** The value a variable is given in an apphosting file, or null when it isn't there. */
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

  it("are on in dev and set off in prod on purpose (a variable left out of the prod file is on there)", () => {
    for (const v of ["BRAND_MAP_SCALE_ENABLED", "BRAND_MAP_SITUATIONS_ENABLED", "BRAND_MAP_IMPORT_ENABLED"]) {
      expect(valueIn("apphosting.yaml", v)).toBe("true");
      expect(valueIn("apphosting.prod.yaml", v)).toBe("false");
    }
  });
});
