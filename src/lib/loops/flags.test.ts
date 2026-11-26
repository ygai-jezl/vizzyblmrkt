import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sourceFiles, stripComments } from "@/lib/ontology/storeScan";
import { isLoopsEnabled } from "./flags";
import { LOOP_SWITCHES } from "./switches";
import { SWITCHES_BEFORE_LOOPS } from "./testing/switchesBeforeLoops";

/**
 * LOOPS_ENABLED, the learning loops' platform switch (learning loops step 5): off unless exactly
 * "true", listed off where every switch is, and read in one place only, so nothing else can turn
 * any of step 5 on.
 */

const ROOT = process.cwd();
const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as { load: (text: string) => unknown };
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

afterEach(() => vi.unstubAllEnvs());

describe("LOOPS_ENABLED", () => {
  it("is off unless it is exactly true", () => {
    vi.stubEnv("LOOPS_ENABLED", "");
    expect(isLoopsEnabled()).toBe(false);
    for (const v of ["1", "yes", "TRUE", " true", "false"]) {
      vi.stubEnv("LOOPS_ENABLED", v);
      expect(isLoopsEnabled(), v).toBe(false);
    }
    vi.stubEnv("LOOPS_ENABLED", "true");
    expect(isLoopsEnabled()).toBe(true);
  });

  it("doesn't follow the image style switch, and image learning doesn't follow it", () => {
    vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "true");
    expect(isLoopsEnabled()).toBe(false);
    vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "false");
    vi.stubEnv("LOOPS_ENABLED", "true");
    expect(LOOP_SWITCHES.IMAGE_STYLE_VERSIONS_ENABLED()).toBe(false);
  });

  it("is listed off in apphosting.yaml for the server only, and empty in .env.example", () => {
    const doc = yaml.load(read("apphosting.yaml")) as { env?: Array<{ variable: string; value?: string; availability?: string[] }> };
    const entries = (doc.env ?? []).filter((e) => e.variable === "LOOPS_ENABLED");
    expect(entries).toEqual([{ variable: "LOOPS_ENABLED", value: "false", availability: ["RUNTIME"] }]);
    expect(read(".env.example")).toMatch(/^LOOPS_ENABLED=$/m);
  });

  it("is the platform's switch, not a loop's own: no learns line can name it, and it is new since the loops", () => {
    expect(Object.keys(LOOP_SWITCHES)).not.toContain("LOOPS_ENABLED");
    expect(SWITCHES_BEFORE_LOOPS).not.toContain("LOOPS_ENABLED");
  });

  it("is read once, in src/lib/loops/flags.ts, and nowhere else", () => {
    const reads = /process\.env(?:\.LOOPS_ENABLED\b|\[\s*["'`]LOOPS_ENABLED["'`]\s*\])/g;
    const readers = sourceFiles("src", ROOT).flatMap((file) => {
      const n = [...stripComments(read(file)).matchAll(reads)].length;
      return n ? [`${file} x${n}`] : [];
    });
    expect(readers).toEqual(["src/lib/loops/flags.ts x1"]);
    expect(read("src/lib/loops/flags.ts")).toContain('process.env.LOOPS_ENABLED === "true"');
  });
});

describe("the operator settings (./operators.ts)", () => {
  it("are empty in .env.example and named, with no value, in the apphosting.yaml comment", () => {
    const example = read(".env.example");
    const hosting = read("apphosting.yaml");
    for (const name of ["LOOPS_OPERATOR_EMAILS", "LOOPS_SOURCE_REPO"]) {
      expect(example, name).toMatch(new RegExp(`^${name}=$`, "m"));
      expect(hosting, name).toMatch(new RegExp(`^ {2}# {5}${name} {2,}\\S`, "m"));
      expect(hosting, name).not.toMatch(new RegExp(`variable: ${name}\\b`));
    }
  });
});
