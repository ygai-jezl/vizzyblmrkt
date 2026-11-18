import { describe, expect, it } from "vitest";
import { brandRoot, resultId, searchChunkId, searchManifestId } from "./searchIndex";
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

describe("resultId", () => {
  it("gives every projected result its own id, from its record and chunk", () => {
    expect(resultId({ id: "c_1" }, undefined, {})).toBe("c_1");
    expect(resultId(undefined, "c_2", {})).toBe("c_2");
    const a = resultId(undefined, undefined, { sourceKey: "situation:sit_1", chunk: 0 });
    const b = resultId(undefined, undefined, { sourceKey: "situation:sit_2", chunk: 0 });
    const c = resultId(undefined, undefined, { sourceKey: "situation:sit_1", chunk: 1 });
    expect(new Set([a, b, c]).size).toBe(3);
    expect(resultId(undefined, undefined, {})).toBe("");
  });
});

