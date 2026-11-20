import { describe, expect, it } from "vitest";
import { readSearchKind, SEARCH_KIND_ALIASES, storedKindsFor } from "@/lib/search/types";
import { brandRoot, manifestFrom, rankedFrom, resultId, searchChunkId, searchManifestId } from "./searchIndex";
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


describe("kinds stored under an alias", () => {
  // An Idea Board item as written before the rename, and while SEARCH_KIND_IDEA_BOARD_ENABLED is off.
  const manifest = { tenantId: "ten_A", sourceKey: "idea:i1", kind: "idea", ref: "i1", hash: "h", chunks: 2, embedded: true, indexedAt: "2026-11-20T10:00:00.000Z" };
  const chunk = { tenantId: "ten_A", sourceKey: "idea:i1", kind: "idea", ref: "i1", chunk: 0, title: "Repot", text: "Repot in spring", url: "/admin/x" };

  it("reads a stored idea as idea_board and keeps the stored sourceKey", () => {
    expect(SEARCH_KIND_ALIASES).toEqual({ idea: "idea_board" });
    expect(manifestFrom(manifest)).toMatchObject({ kind: "idea_board", sourceKey: "idea:i1", chunks: 2 });
    expect(rankedFrom("c_1", chunk, "ten_A")).toMatchObject({ kind: "idea_board", sourceKey: "idea:i1", ref: "i1" });
  });

  it("reads a stored idea_board as itself", () => {
    const renamed = { sourceKey: "idea_board:i1", kind: "idea_board" };
    expect(manifestFrom({ ...manifest, ...renamed })).toMatchObject({ kind: "idea_board", sourceKey: "idea_board:i1" });
    expect(rankedFrom("c_1", { ...chunk, ...renamed }, "ten_A")).toMatchObject({ kind: "idea_board", sourceKey: "idea_board:i1" });
  });

  it("asks for both names when filtering by a kind that has an alias", () => {
    expect(storedKindsFor(["idea_board"])).toEqual(["idea_board", "idea"]);
    expect(storedKindsFor(["article", "idea_board"])).toEqual(["article", "idea_board", "idea"]);
    expect(storedKindsFor(["article"])).toEqual(["article"]);
  });

  it("still drops unknown kinds and other brands' chunks", () => {
    expect(readSearchKind("people")).toBeNull();
    expect(readSearchKind("constructor")).toBeNull();
    expect(manifestFrom({ ...manifest, kind: "people" })).toBeNull();
    expect(rankedFrom("c_1", { ...chunk, kind: "people" }, "ten_A")).toBeNull();
    expect(rankedFrom("c_1", chunk, "ten_B")).toBeNull();
    expect(manifestFrom(undefined)).toBeNull();
  });
});
