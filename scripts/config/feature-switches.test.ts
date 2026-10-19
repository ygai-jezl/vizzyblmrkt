import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { codeFeatureSwitches, NOT_FEATURE_SWITCHES, switchReads } from "./feature-switches.mjs";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as { load: (text: string) => unknown };

const ROOT = process.cwd();

type Entry = { variable: string; value?: string; secret?: string; availability?: string[] };

/** The env entries of the public apphosting.yaml. */
function baseEntries(): Entry[] {
  const doc = yaml.load(readFileSync(join(ROOT, "apphosting.yaml"), "utf8")) as { env?: Entry[] };
  return doc.env ?? [];
}

/**
 * Settings the public apphosting.yaml may hold besides switches: the same for every
 * deployment. Anything that names one deployment belongs in apphosting.<environment>.yaml.
 */
const SHARED_SETTINGS = [
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_CLOUD_LOCATION",
  "BRAND_BEST_OF_N_COUNT",
  "WAITLIST_ENGINE_PILOT_TENANTS",
  "BQ_DATASET_US",
  "BQ_DATASET_EU",
  "BQ_DATASET_ASIA",
];

describe("switchReads", () => {
  it("finds variables compared with the exact string true, either way round", () => {
    const text = [
      'return process.env.A_ENABLED === "true";',
      'if (process.env.B_ENABLED !== "true") return;',
      'const c = process.env.C_ENABLED == "true" && process.env.A_ENABLED === "true";',
      'const n = Number(process.env.D_COUNT); const e = process.env.E_MODE === "live";',
    ].join("\n");
    expect(switchReads(text)).toEqual(["A_ENABLED", "B_ENABLED", "C_ENABLED"]);
  });
});

describe("the public apphosting.yaml", () => {
  const entries = baseEntries();
  const byName = new Map(entries.map((e) => [e.variable, e]));
  const switches = codeFeatureSwitches(ROOT);

  it("finds the switches in the code (a sanity check on the scan)", () => {
    expect(switches.length).toBeGreaterThan(50);
    expect(switches).toContain("LIFECYCLE_ENABLED");
    expect(switches).toContain("LIFECYCLE_CONSENT_AT_SEND");
    for (const name of Object.keys(NOT_FEATURE_SWITCHES)) expect(switches).not.toContain(name);
  });

  it('lists every switch the code reads, each one "false" (add a new switch here, off)', () => {
    const missing = switches.filter((name) => !byName.has(name));
    const notOff = switches.filter((name) => byName.has(name) && byName.get(name)!.value !== "false");
    expect(missing, "switches the code reads that apphosting.yaml doesn't list").toEqual([]);
    expect(notOff, 'switches apphosting.yaml doesn\'t set to "false"').toEqual([]);
  });

  it("gives NEXT_PUBLIC_ switches BUILD as well, since they are built into the page", () => {
    const noBuild = switches.filter((n) => n.startsWith("NEXT_PUBLIC_") && !(byName.get(n)?.availability ?? ["BUILD"]).includes("BUILD"));
    expect(noBuild).toEqual([]);
  });

  it("lists no switch the code no longer reads", () => {
    const stale = entries.filter((e) => e.value === "false" && !switches.includes(e.variable)).map((e) => e.variable);
    expect(stale).toEqual([]);
  });

  it("refers to no secret, so a fork's first build never waits on one", () => {
    expect(entries.filter((e) => "secret" in e).map((e) => e.variable)).toEqual([]);
    expect(readFileSync(join(ROOT, "apphosting.yaml"), "utf8")).not.toMatch(/^\s*secret:/m);
  });

  it("holds no other settings than the ones every deployment shares", () => {
    const other = entries.filter((e) => !switches.includes(e.variable) && !SHARED_SETTINGS.includes(e.variable)).map((e) => e.variable);
    expect(other, "these name one deployment: put them in apphosting.<environment>.yaml").toEqual([]);
  });

  it("defines each variable once", () => {
    const names = entries.map((e) => e.variable);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
  });
});
