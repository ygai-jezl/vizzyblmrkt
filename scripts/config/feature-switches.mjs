// The feature switches the app reads, found in the code itself, so apphosting.yaml can be
// checked against them. A switch is a variable the code compares with the exact string
// "true" (`process.env.X === "true"` or `!== "true"`): anything else, or unset, is off.
// Node built-ins only.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Variables read as `=== "true"` that are settings rather than features, so they are not
 * listed off in apphosting.yaml. Each needs a reason.
 * @type {Record<string, string>}
 */
export const NOT_FEATURE_SWITCHES = {
  GOOGLE_GENAI_USE_VERTEXAI: "picks Vertex AI over the Gemini API; apphosting.yaml sets it for every deployment",
  ALLOW_SEED: "opens the demo seed route for a local run; never set on a deployment",
};

const SWITCH_READ = /process\.env\.([A-Z][A-Z0-9_]*)\s*[!=]==?\s*"true"/g;
const SOURCE_FILE = /\.(?:ts|tsx|mjs|js)$/;
const TEST_FILE = /\.test\.(?:ts|tsx|mjs|js)$/;

/**
 * Names of the variables `text` reads as switches, in order of first use.
 * @param {string} text
 * @returns {string[]}
 */
export function switchReads(text) {
  const names = [];
  for (const m of String(text).matchAll(SWITCH_READ)) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

/**
 * Every feature switch the app's code (src/, tests left out) reads, sorted, without the
 * settings in NOT_FEATURE_SWITCHES.
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function codeFeatureSwitches(repoRoot) {
  const found = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
        for (const name of switchReads(readFileSync(path, "utf8"))) found.add(name);
      }
    }
  };
  walk(join(repoRoot, "src"));
  return [...found].filter((name) => !(name in NOT_FEATURE_SWITCHES)).sort();
}
