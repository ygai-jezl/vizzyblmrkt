import { describe, expect, it, vi } from "vitest";
import { MemorySearchIndex } from "@/lib/search/memoryStore";
import { deleteOldVectors, indexCounts, RETIRE_NEEDS, retireBlockers, retireCounts, retireLines, switchesNotOn } from "@/lib/search/retire";
import { countBrandMapVectors, deleteBrandMapVectors, writeBrandMapVector } from "@/lib/tenant/brandMapVectors";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { entryMap } from "../selfhost/envfile.mjs";

// scripts/retire-old-vectors.ts (ADR-0023): its switch guard, its counts and its refusal.

const settings = (on: readonly string[]) =>
  entryMap(
    RETIRE_NEEDS.map((name) => `  - variable: ${name}\n    value: "${on.includes(name) ? "true" : "false"}"\n    availability:\n      - RUNTIME\n`).join(""),
  ) as Map<string, { value?: string }>;

describe("the switch guard", () => {
  it("refuses unless the index, the family, the three read switches and the retire switch are all on in the settings file", () => {
    expect(switchesNotOn(settings(RETIRE_NEEDS))).toEqual([]);
    expect(switchesNotOn(settings(RETIRE_NEEDS.filter((n) => n !== "SEARCH_NOTE_READS_ENABLED")))).toEqual(["SEARCH_NOTE_READS_ENABLED"]);
    expect(switchesNotOn(settings(RETIRE_NEEDS.filter((n) => n !== "SEARCH_OLD_VECTORS_RETIRED_ENABLED")))).toEqual(["SEARCH_OLD_VECTORS_RETIRED_ENABLED"]);
    expect(switchesNotOn(new Map())).toEqual([...RETIRE_NEEDS]);
  });
});

describe("the counts, the refusal and the delete", () => {
  const A: TenantContext = { tenantId: "ten_A", region: "us", source: "system" };
  const B: TenantContext = { tenantId: "ten_B", region: "eu", source: "system" };

  async function setup() {
    const db = new FakeFirestore();
    const index = new MemorySearchIndex();
    const put = async (ctx: TenantContext, kind: "subject" | "note" | "question" | "competitor", ref: string) =>
      index.storeFor(ctx).putSource({ sourceKey: `${kind}:${ref}`, kind, ref, hash: "h", chunks: 0, embedded: true, indexedAt: "" }, [], 0);
    for (const ref of ["sub_1", "sub_2"]) await writeBrandMapVector(A, { kind: "subject", ref, status: "decided" }, [0.1], db);
    await writeBrandMapVector(A, { kind: "question", ref: "bn_q", status: "asked" }, [0.1], db);
    await writeBrandMapVector(B, { kind: "competitor_article", ref: "art_1", status: "kept" }, [0.1], db);
    await put(A, "subject", "sub_1");
    await put(A, "subject", "sub_2");
    await put(A, "question", "note_bn_q");
    // A brand map question and a competitor's summary are not what the old store held.
    await put(B, "question", "q_1");
    await put(B, "competitor", "cmp_1");
    const deps = {
      store: (ctx: { tenantId: string }) => index.storeFor(ctx),
      countOld: (ctx: TenantContext, kind: Parameters<typeof countBrandMapVectors>[1]) => countBrandMapVectors(ctx, kind, db),
      deleteOld: vi.fn((ctx: TenantContext, kind: Parameters<typeof deleteBrandMapVectors>[1]) => deleteBrandMapVectors(ctx, kind, db)),
    };
    return { db, index, put, deps };
  }

  it("counts per region, brand and kind, and refuses a brand that holds old vectors with nothing in brand search", async () => {
    const { deps, put } = await setup();
    const tenants = [
      { id: "ten_A", region: "us" as const },
      { id: "ten_B", region: "eu" as const },
    ];
    const rows = await retireCounts(tenants, deps);
    expect(rows).toEqual([
      { tenantId: "ten_A", region: "us", kind: "subject", old: 2, index: 2 },
      { tenantId: "ten_A", region: "us", kind: "question", old: 1, index: 1 },
      { tenantId: "ten_B", region: "eu", kind: "competitor_article", old: 1, index: 0 },
    ]);
    expect(retireBlockers(rows)).toEqual([rows[2]]);
    expect(retireLines(rows)).toEqual([
      "us ten_A subject: 2 old, 2 in brand search",
      "us ten_A question: 1 old, 1 in brand search",
      "eu ten_B competitor_article: 1 old, 0 in brand search  REFUSED: nothing in brand search",
      "us in all: 3 old vectors, 3 records in brand search",
      "eu in all: 1 old vector, 0 records in brand search",
    ]);
    // Once the backfill has put the article in brand search, nothing refuses.
    await put({ tenantId: "ten_B", region: "eu", source: "system" }, "competitor", "cmp_1/art_1");
    expect(retireBlockers(await retireCounts(tenants, deps))).toEqual([]);
  });

  it("deletes what it counted, brand by brand, through the old store's own file", async () => {
    const { deps, db } = await setup();
    const rows = await retireCounts([{ id: "ten_A", region: "us" }], deps);
    expect(await deleteOldVectors(rows, deps)).toBe(3);
    expect(deps.deleteOld).toHaveBeenCalledTimes(2);
    expect(await countBrandMapVectors(A, "subject", db)).toBe(0);
    expect(await countBrandMapVectors(B, "competitor_article", db)).toBe(1);
  });

  it("reads brand search's kinds as the old store's", () => {
    const m = (kind: "note" | "question" | "competitor" | "situation", ref: string) => ({ sourceKey: `${kind}:${ref}`, kind, ref, hash: "", chunks: 1, embedded: true, indexedAt: "" });
    expect(indexCounts([m("note", "bn_1"), m("question", "note_bn_2"), m("question", "q_3"), m("competitor", "cmp/art"), m("competitor", "cmp"), m("situation", "sit_1")])).toEqual({
      subject: 0,
      situation: 1,
      note: 1,
      question: 1,
      competitor_article: 1,
    });
  });
});
