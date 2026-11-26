import { describe, expect, it, vi } from "vitest";
import { readSearchKind, SEARCH_KIND_ALIASES, storedKindsFor } from "@/lib/search/types";
import { bestPerRecord, brandRoot, manifestFrom, nearestFrom, rankedFrom, resultId, searchChunkId, searchManifestId, searchStoreFor } from "./searchIndex";
import { SEARCH_DATABASE_IDS, searchDatabaseIdForRegion } from "./region";

// @google-cloud/firestore 9 and its pipelines, recording when each loads and which clients are made.
const sdk = vi.hoisted(() => ({ loads: 0, pipelineLoads: 0, made: [] as Array<Record<string, unknown>> }));
vi.mock("@google-cloud/firestore", () => {
  sdk.loads++;
  class Firestore {
    constructor(opts: Record<string, unknown>) {
      sdk.made.push(opts);
    }
    collection() {
      return { doc: () => ({ get: async () => ({ data: () => undefined }) }) };
    }
  }
  return { Firestore, FieldValue: { vector: (v: number[]) => ({ vector: v }) } };
});
vi.mock("@google-cloud/firestore/pipelines", () => {
  sdk.pipelineLoads++;
  return {};
});

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

describe("statuses (ADR-0025)", () => {
  const chunk = { tenantId: "ten_A", sourceKey: "subject:sub_1", kind: "subject", ref: "sub_1", chunk: 0, title: "Repot", text: "Repot", url: "/admin/x" };

  it("reads a chunk's and a manifest's status, and leaves out one that isn't a status", () => {
    expect(rankedFrom("c_1", { ...chunk, status: "proposed" }, "ten_A")).toMatchObject({ status: "proposed" });
    expect(rankedFrom("c_1", chunk, "ten_A")).not.toHaveProperty("status");
    expect(rankedFrom("c_1", { ...chunk, status: "archived" }, "ten_A")).not.toHaveProperty("status");
    const m = { sourceKey: "subject:sub_1", kind: "subject", ref: "sub_1", hash: "h", chunks: 1, embedded: true, indexedAt: "" };
    expect(manifestFrom({ ...m, status: "decided" })).toMatchObject({ status: "decided" });
    expect(manifestFrom(m)).not.toHaveProperty("status");
  });

  it("makes a reader's hit only of this brand's chunks with a status asked for, its score clamped", () => {
    expect(nearestFrom({ ...chunk, status: "decided", _score: 0.82 }, "ten_A", ["decided"])).toEqual({ sourceKey: "subject:sub_1", kind: "subject", ref: "sub_1", status: "decided", score: 0.82 });
    expect(nearestFrom({ ...chunk, status: "decided", _score: 1.0000001 }, "ten_A", ["decided"])?.score).toBe(1);
    expect(nearestFrom({ ...chunk, status: "decided", _score: -0.2 }, "ten_A", ["decided"])?.score).toBe(0);
    expect(nearestFrom({ ...chunk, status: "proposed", _score: 0.9 }, "ten_A", ["decided"])).toBeNull();
    expect(nearestFrom({ ...chunk, _score: 0.9 }, "ten_A", ["decided"])).toBeNull();
    expect(nearestFrom({ ...chunk, status: "decided", _score: 0.9 }, "ten_B", ["decided"])).toBeNull();
    expect(nearestFrom({ ...chunk, kind: "people", status: "decided", _score: 0.9 }, "ten_A", ["decided"])).toBeNull();
  });

  it("keeps each record once by its best chunk, nearest first, up to the limit", () => {
    const hit = (sourceKey: string, score: number) => ({ sourceKey, kind: "subject" as const, ref: sourceKey.slice(8), status: "decided" as const, score });
    const best = bestPerRecord([hit("subject:a", 0.5), hit("subject:b", 0.7), null, hit("subject:a", 0.9), hit("subject:c", 0.1)], 2);
    expect(best.map((h) => [h.sourceKey, h.score])).toEqual([
      ["subject:a", 0.9],
      ["subject:b", 0.7],
    ]);
  });
});

describe("loading the search client", () => {
  it("loads @google-cloud/firestore with the index's first use, and makes one client per database", async () => {
    expect(sdk.loads).toBe(0);
    const eu = searchStoreFor({ tenantId: "ten_fernleaf", region: "eu" });
    expect(sdk.loads).toBe(0);

    await expect(Promise.all([eu.getManifest("article:p1"), eu.getManifest("article:p2")])).resolves.toEqual([null, null]);
    expect(sdk.loads).toBe(1);
    expect(sdk.made).toEqual([expect.objectContaining({ databaseId: "search-eu", ignoreUndefinedProperties: true })]);

    await searchStoreFor({ tenantId: "ten_bramble", region: "eu" }).getManifest("article:p3");
    expect(sdk.made).toHaveLength(1);
    await searchStoreFor({ tenantId: "ten_bramble", region: "us" }).getManifest("article:p3");
    expect(sdk.made.map((o) => o.databaseId)).toEqual(["search-eu", "search"]);
    expect(sdk.loads).toBe(1);
    // Pipelines load with the first search, not with the client.
    expect(sdk.pipelineLoads).toBe(0);
  });
});
