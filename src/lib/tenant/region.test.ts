import { describe, it, expect } from "vitest";
import {
  REGION_CONFIGS,
  DEFAULT_DATABASE_ID,
  databaseIdForRegion,
} from "./region";
import type { Region } from "@/lib/types/tenant";

describe("region → database resolution", () => {
  it("maps the US region to the default database", () => {
    expect(databaseIdForRegion("us")).toBe(DEFAULT_DATABASE_ID);
  });

  it("resolves EU and Asia to their named databases (now provisioned)", () => {
    expect(databaseIdForRegion("eu")).toBe("signups-eu");
    expect(databaseIdForRegion("asia")).toBe("signups-asia");
  });

  it("throws (never silently defaults) for an unknown region", () => {
    // The provisioned-check guard still protects any future region added
    // before its database exists; an unknown region must also fail loudly.
    expect(() => databaseIdForRegion("antarctica" as Region)).toThrow(
      /No database configured/,
    );
  });

  it("all three regions are provisioned", () => {
    expect(REGION_CONFIGS.us.provisioned).toBe(true);
    expect(REGION_CONFIGS.eu.provisioned).toBe(true);
    expect(REGION_CONFIGS.asia.provisioned).toBe(true);
  });

  it("uses logical db ids decoupled from the immutable physical location", () => {
    expect(REGION_CONFIGS.us.firestoreLocation).toBe("nam5");
    expect(REGION_CONFIGS.eu.firestoreLocation).toBe("eur3");
    // No Asia multi-region exists — must be a single regional location.
    expect(REGION_CONFIGS.asia.firestoreLocation).toMatch(/^asia-/);
  });
});
