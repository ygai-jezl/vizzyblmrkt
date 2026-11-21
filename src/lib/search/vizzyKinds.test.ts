import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SEARCH_KIND_ALIASES, SEARCH_KINDS } from "./types";

/**
 * Vizzy's search_brand client keeps its own list of kinds (agents/root_agent/tools/search_client.py)
 * and drops any kind not on it. This keeps that list in step with the app's: today's kinds plus
 * the older names the app still takes.
 */
const CLIENT = readFileSync(join(process.cwd(), "agents", "root_agent", "tools", "search_client.py"), "utf8");

/** The quoted strings inside a Python block, with comment lines left out. */
function stringsIn(block: string): string[] {
  const code = block
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  return [...code.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
}

describe("Vizzy's search kinds", () => {
  it("are the app's kinds plus the older names it takes", () => {
    const block = CLIENT.match(/^KINDS = \(([\s\S]*?)^\)/m)?.[1];
    expect(block, "KINDS = (...) not found in search_client.py").toBeDefined();
    const kinds = stringsIn(block!);
    expect(new Set(kinds).size, "a kind is listed twice").toBe(kinds.length);
    expect(new Set(kinds)).toEqual(new Set([...SEARCH_KINDS, ...Object.keys(SEARCH_KIND_ALIASES)]));
  });

  it("send idea_board as idea, which every version of the app takes", () => {
    // A later change flips this, so Vizzy sends idea_board itself, once every environment runs
    // piece 0a or later and Vizzy is redeployed everywhere. Update this test with it.
    const block = CLIENT.match(/^_SEND_AS = \{([^}]*)\}/m)?.[1];
    expect(block, "_SEND_AS = {...} not found in search_client.py").toBeDefined();
    const pairs = Object.fromEntries([...block!.matchAll(/"([^"]+)"\s*:\s*"([^"]+)"/g)].map((m) => [m[1]!, m[2]!]));
    expect(pairs).toEqual({ idea_board: "idea" });
    // Whatever Vizzy sends is a name the app reads.
    for (const sent of Object.values(pairs)) expect(SEARCH_KINDS.includes(sent as never) || sent in SEARCH_KIND_ALIASES, sent).toBe(true);
  });
});
