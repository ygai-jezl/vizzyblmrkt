import { describe, expect, it } from "vitest";
import { brandRoot, searchChunkId, searchManifestId } from "./searchIndex";
import { SEARCH_DATABASE_IDS, searchDatabaseIdForRegion } from "./region";

describe("brand search paths", () => {
  it("gives each brand its own folder and refuses ids that could leave it", () => {
    expect(brandRoot("ten_fernleaf")).toBe("brands/ten_fernleaf");
    for (const bad of ["", "a/b", "../x", "ten one", "ten_x/search_docs/doc", "x".repeat(129)]) {
      expect(() => brandRoot(bad)).toThrow("search_index_bad_tenant");
    }
  });

  it("makes stable ids that differ per record and per chunk", () => {
    expect(searchChunkId("article:p1", 0)).toBe(searchChunkId("article:p1", 0));
    expect(searchChunkId("article:p1", 0)).not.toBe(searchChunkId("article:p1", 1));
    expect(searchChunkId("article:p1", 0)).not.toBe(searchChunkId("article:p2", 0));
    expect(searchManifestId("article:p1")).toMatch(/^s_[0-9a-f]{32}$/);
  });

  it("keeps each region's index in its own database", () => {
    expect(searchDatabaseIdForRegion("us")).toBe("search");
    expect(searchDatabaseIdForRegion("eu")).toBe("search-eu");
    expect(searchDatabaseIdForRegion("asia")).toBe("search-asia");
    expect(new Set(Object.values(SEARCH_DATABASE_IDS)).size).toBe(3);
  });
});
