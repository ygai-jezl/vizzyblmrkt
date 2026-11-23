import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateGroundedJson, generateGroundedText } from "./gemini";

/**
 * Every Google search the product runs is counted (WEB_SEARCH_METER_ENABLED): only gemini.ts asks
 * Gemini to search, and its two grounded helpers can't be called without a meter.
 */

const SRC = join(process.cwd(), "src");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("web searches are always metered", () => {
  it("only gemini.ts asks Gemini to search Google", () => {
    const searching = files(SRC).filter((f) => /googleSearch\s*:/.test(readFileSync(f, "utf8")));
    expect(searching.map((f) => f.slice(SRC.length + 1))).toEqual([join("lib", "agents", "gemini.ts")]);
  });

  it("the grounded helpers need a meter", () => {
    // Type checks only: never called.
    const typed = () => {
      // @ts-expect-error a grounded call without a meter doesn't compile
      void generateGroundedText("find", { timeoutMs: 1 });
      // @ts-expect-error a grounded call without a meter doesn't compile
      void generateGroundedJson("find");
    };
    expect(typeof typed).toBe("function");
  });
});
