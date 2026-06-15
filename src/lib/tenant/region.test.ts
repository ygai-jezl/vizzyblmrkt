import { describe, it, expect } from "vitest";
import {
  REGION_CONFIGS,
  DEFAULT_DATABASE_ID,
  databaseIdForRegion,
} from "./region";

describe("region → database resolution", () => {
  it("maps the US region to the default database", () => {
    expect(databaseIdForRegion("us")).toBe(DEFAULT_DATABASE_ID);
  });

  it("throws (never silently defaults) for an unprovisioned region", () => {
    // eu/asia databases aren't provisioned yet — must fail loudly so a tenant's
    // data is never written into the wrong region.
    expect(() => databaseIdForRegion("eu")).toThrow(/not provisioned/);
    expect(() => databaseIdForRegion("asia")).toThrow(/not provisioned/);
  });

  it("only the US database is provisioned today", () => {
    expect(REGION_CONFIGS.us.provisioned).toBe(true);
    expect(REGION_CONFIGS.eu.provisioned).toBe(false);
    expect(REGION_CONFIGS.asia.provisioned).toBe(false);
  });

  it("uses logical db ids decoupled from the immutable physical location", () => {
    expect(REGION_CONFIGS.us.firestoreLocation).toBe("nam5");
    expect(REGION_CONFIGS.eu.firestoreLocation).toBe("eur3");
    // No Asia multi-region exists — must be a single regional location.
    expect(REGION_CONFIGS.asia.firestoreLocation).toMatch(/^asia-/);
  });
});
