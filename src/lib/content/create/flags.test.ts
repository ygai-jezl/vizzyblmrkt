import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isSuggestAngleEnabled } from "./flags";

afterEach(() => vi.unstubAllEnvs());

/** The value apphosting.yaml (the public base) gives a variable, or null when it isn't there. */
function valueIn(file: string, variable: string): string | null {
  const text = readFileSync(join(process.cwd(), file), "utf8");
  const m = new RegExp(`- variable: ${variable}\\n\\s+value: "([^"]*)"`).exec(text);
  return m ? m[1]! : null;
}

describe("the Suggest an angle switch", () => {
  it("is on only when set to true", () => {
    expect(isSuggestAngleEnabled()).toBe(false);
    vi.stubEnv("CREATE_SUGGEST_ANGLE_ENABLED", "1");
    expect(isSuggestAngleEnabled()).toBe(false);
    vi.stubEnv("CREATE_SUGGEST_ANGLE_ENABLED", "true");
    expect(isSuggestAngleEnabled()).toBe(true);
  });

  it("is listed off in the public apphosting.yaml, like every switch", () => {
    expect(valueIn("apphosting.yaml", "CREATE_SUGGEST_ANGLE_ENABLED")).toBe("false");
  });
});
