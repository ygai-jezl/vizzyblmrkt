import { describe, expect, it, vi } from "vitest";
import { MemorySearchIndex } from "@/lib/search/memoryStore";
import { deleteOldVectors, indexCounts, keptOutOfIndex, RETIRE_NEEDS, retireBlockers, retireCounts, retireLines, switchesNotOn } from "@/lib/search/retire";
import type { SearchStatus } from "@/lib/search/types";
import { countBrandMapVectors, deleteBrandMapVectors, listBrandMapVectorRefs, writeBrandMapVector } from "@/lib/tenant/brandMapVectors";
import type { BrandNote } from "@/lib/types/brandNote";
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

  /** The status the family gives each kind; `null` for an entry written before the family, which no reader finds. */
  const FAMILY_STATUS = { subject: "decided", note: "kept", question: "asked", competitor: "kept" } as const;

  async function setup(notes: BrandNote[] = []) {
    const db = new FakeFirestore();
    const index = new MemorySearchIndex();
    const put = async (ctx: TenantContext, kind: "subject" | "note" | "question" | "competitor", ref: string, status: SearchStatus | null = FAMILY_STATUS[kind]) =>
      index.storeFor(ctx).putSource({ sourceKey: `${kind}:${ref}`, kind, ref, hash: "h", chunks: 0, embedded: true, indexedAt: "", ...(status ? { status } : {}) }, [], 0);
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
      listOld: (ctx: TenantContext, kind: Parameters<typeof listBrandMapVectorRefs>[1]) => listBrandMapVectorRefs(ctx, kind, db),
      deleteOld: vi.fn((ctx: TenantContext, kind: Parameters<typeof deleteBrandMapVectors>[1]) => deleteBrandMapVectors(ctx, kind, db)),
      notes: async (ctx: TenantContext) => notes.filter((n) => n.tenantId === ctx.tenantId),
    };
    return { db, index, put, deps };
  }

  /** A made-up note of brand A: kept and typed unless told otherwise. */
  const note = (id: string, over: Partial<BrandNote> = {}) => ({ id, tenantId: "ten_A", text: "We repot in spring.", status: "kept", canName: false, source: "typed", question: null, ...over }) as BrandNote;

  it("counts per region, brand and kind, and refuses a brand that holds old vectors with nothing in brand search", async () => {
    const { deps, put } = await setup([note("bn_q", { status: "asked", text: "", source: "question", question: "When do you repot?" })]);
    const tenants = [
      { id: "ten_A", region: "us" as const },
      { id: "ten_B", region: "eu" as const },
    ];
    const rows = await retireCounts(tenants, deps);
    expect(rows).toEqual([
      { tenantId: "ten_A", region: "us", kind: "subject", old: 2, index: 2, keptOut: 0 },
      { tenantId: "ten_A", region: "us", kind: "question", old: 1, index: 1, keptOut: 0 },
      { tenantId: "ten_B", region: "eu", kind: "competitor_article", old: 1, index: 0, keptOut: 0 },
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

  it("refuses a brand whose brand search entries have no status, since no reader finds them", async () => {
    const { deps, put } = await setup([note("bn_q", { status: "asked", text: "", source: "question", question: "When do you repot?" })]);
    const A2 = { tenantId: "ten_A", region: "us", source: "system" } as const;
    // Entries written for people's search before the family (no status): the sweep never gave them theirs.
    await put(A2, "subject", "sub_1", null);
    await put(A2, "subject", "sub_2", null);
    await put(A2, "question", "note_bn_q", null);
    const rows = await retireCounts([{ id: "ten_A", region: "us" }], deps);
    expect(rows.map((r) => `${r.kind} ${r.old} ${r.index}`)).toEqual(["subject 2 0", "question 1 0"]);
    expect(retireBlockers(rows).map((r) => r.kind)).toEqual(["subject", "question"]);
    // Once the family's statuses are written, nothing refuses.
    await put(A2, "subject", "sub_1");
    await put(A2, "question", "note_bn_q");
    expect(retireBlockers(await retireCounts([{ id: "ten_A", region: "us" }], deps))).toEqual([]);
  });

  it("doesn't refuse over notes brand search never holds, and deletes them with the rest", async () => {
    // Every kept note may name a customer, and the only other was suggested and never kept (decision 40).
    const C = { tenantId: "ten_C", region: "us", source: "system" } as const;
    const mine = { tenantId: "ten_C" };
    const notes = [note("bn_named1", { ...mine, canName: true }), note("bn_named2", { ...mine, canName: true, source: "question", question: "Who asked?" }), note("bn_sugg", { ...mine, status: "suggested" })];
    const { db, deps } = await setup(notes);
    for (const ref of ["bn_named1", "bn_named2", "bn_sugg", "bn_gone"]) await writeBrandMapVector(C, { kind: "note", ref, status: "kept" }, [0.1], db);
    await writeBrandMapVector(C, { kind: "question", ref: "bn_named2", status: "answered" }, [0.1], db);
    const rows = await retireCounts([{ id: "ten_C", region: "us" }], deps);
    expect(rows).toEqual([
      { tenantId: "ten_C", region: "us", kind: "note", old: 4, index: 0, keptOut: 4 },
      { tenantId: "ten_C", region: "us", kind: "question", old: 1, index: 0, keptOut: 1 },
    ]);
    expect(retireBlockers(rows)).toEqual([]);
    expect(retireLines(rows)[0]).toBe("us ten_C note: 4 old (4 of records brand search never holds), 0 in brand search");
    expect(await deleteOldVectors(rows, deps)).toBe(5);
    expect(await countBrandMapVectors(C, "note", db)).toBe(0);
  });

  it("still refuses when a note brand search should hold is missing, beside ones it never holds", () => {
    const notes = [note("bn_kept"), note("bn_named", { canName: true }), note("bn_asked", { status: "asked", text: "", source: "question", question: "When?" })];
    expect(keptOutOfIndex("note", ["bn_kept", "bn_named", "bn_asked"], notes)).toBe(2);
    expect(keptOutOfIndex("question", ["bn_kept", "bn_asked"], notes)).toBe(1);
    const row = { tenantId: "ten_A", region: "us" as const, kind: "note" as const, old: 3, index: 0, keptOut: 2 };
    expect(retireBlockers([row])).toEqual([row]);
  });

  it("deletes what it counted, brand by brand, through the old store's own file", async () => {
    const { deps, db } = await setup([note("bn_q", { status: "asked", text: "", source: "question", question: "When do you repot?" })]);
    const rows = await retireCounts([{ id: "ten_A", region: "us" }], deps);
    expect(await deleteOldVectors(rows, deps)).toBe(3);
    expect(deps.deleteOld).toHaveBeenCalledTimes(2);
    expect(await countBrandMapVectors(A, "subject", db)).toBe(0);
    expect(await countBrandMapVectors(B, "competitor_article", db)).toBe(1);
  });

  it("reads brand search's kinds as the old store's, counting only entries with the family's status", () => {
    const m = (kind: "note" | "question" | "competitor" | "situation", ref: string, status?: SearchStatus) => ({ sourceKey: `${kind}:${ref}`, kind, ref, hash: "", chunks: 1, embedded: true, indexedAt: "", ...(status ? { status } : {}) });
    expect(
      indexCounts([m("note", "bn_1", "kept"), m("question", "note_bn_2", "answered"), m("question", "q_3", "decided"), m("competitor", "cmp/art", "kept"), m("competitor", "cmp"), m("situation", "sit_1", "proposed")]),
    ).toEqual({ subject: 0, situation: 1, note: 1, question: 1, competitor_article: 1 });
    // The same entries with no status, as people's search kept them before the family: no reader finds them.
    expect(indexCounts([m("note", "bn_1"), m("question", "note_bn_2"), m("competitor", "cmp/art"), m("situation", "sit_1")])).toEqual({
      subject: 0,
      situation: 0,
      note: 0,
      question: 0,
      competitor_article: 0,
    });
  });
});
