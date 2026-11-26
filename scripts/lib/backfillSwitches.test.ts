import { describe, expect, it } from "vitest";
import { entryMap } from "../selfhost/envfile.mjs";
import { backfillSwitches } from "./backfillSwitches";

// scripts/search-backfill.ts writes what the deployment's scheduled check writes (ADR-0023).

const file = (values: Record<string, string>) => ({
  path: "apphosting.test.yaml",
  entries: entryMap(Object.entries(values).map(([name, value]) => `  - variable: ${name}\n    value: "${value}"\n    availability:\n      - RUNTIME\n`).join("")) as Map<string, { value?: string }>,
});

describe("what the backfill writes", () => {
  it("follows the deployment's settings file, whatever the shell says", () => {
    expect(backfillSwitches({ allBrands: false, settings: file({ SEARCH_FAMILY_INDEX_ENABLED: "true", SEARCH_KIND_IDEA_BOARD_ENABLED: "true" }) })).toEqual({
      env: { SEARCH_FAMILY_INDEX_ENABLED: "true", SEARCH_KIND_IDEA_BOARD_ENABLED: "true" },
    });
    // A switch the file leaves out is off, as the base apphosting.yaml has it.
    expect(backfillSwitches({ allBrands: false, settings: file({ SEARCH_INDEX_ENABLED: "true" }) })).toEqual({
      env: { SEARCH_FAMILY_INDEX_ENABLED: "false", SEARCH_KIND_IDEA_BOARD_ENABLED: "false" },
    });
    expect(backfillSwitches({ allBrands: true, settings: file({ SEARCH_FAMILY_INDEX_ENABLED: "true" }) })).toEqual({
      env: { SEARCH_FAMILY_INDEX_ENABLED: "true", SEARCH_KIND_IDEA_BOARD_ENABLED: "false" },
    });
  });

  it("takes --all-brands alone as a deployment that keeps the family", () => {
    expect(backfillSwitches({ allBrands: true, settings: null })).toEqual({ env: { SEARCH_FAMILY_INDEX_ENABLED: "true" } });
  });

  it("refuses to guess: no settings and no --all-brands, or --all-brands where the file keeps the family off", () => {
    const none = backfillSwitches({ allBrands: false, settings: null });
    expect("refuse" in none && none.refuse).toContain("--settings");
    const off = backfillSwitches({ allBrands: true, settings: file({ SEARCH_FAMILY_INDEX_ENABLED: "false" }) });
    expect("refuse" in off && off.refuse).toContain('SEARCH_FAMILY_INDEX_ENABLED isn\'t "true" in apphosting.test.yaml');
  });
});
