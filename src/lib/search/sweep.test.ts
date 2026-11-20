import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubOf } from "./feeders";
import { MemorySearchIndex } from "./memoryStore";
import { isSweepTick, runSearchSweeps, sweepBrand } from "./sweep";
import type { SearchChunkDoc, SearchKind, SearchManifest, SearchSource } from "./types";

vi.mock("@/lib/tenant/searchIndex", () => ({
  searchStoreFor: () => {
    throw new Error("tests pass their own store");
  },
}));

const ctx = { tenantId: "ten_fernleaf", region: "us" as const, source: "system" as const };
const unitEmbed = vi.fn(async (items: unknown[]) => items.map(() => [1, 0, 0]));
const src = (kind: SearchKind, ref: string, body: string): SearchSource => ({ kind, ref, title: ref, body });
const reader = (sources: SearchSource[], complete: SearchKind[]) => async () => ({ stubs: sources.map(stubOf), complete: new Set(complete) });

describe("sweepBrand", () => {
  beforeEach(() => {
    vi.stubEnv("SEARCH_INDEX_ENABLED", "true");
    unitEmbed.mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("indexes new records, skips unchanged ones and re-indexes changed ones", async () => {
    const index = new MemorySearchIndex();
    const store = index.storeFor(ctx);
    const first = await sweepBrand(ctx, {}, { store, embed: unitEmbed, read: reader([src("idea", "i1", "Repot in spring"), src("note", "n1", "Fans love citrus")], ["idea", "note"]) });
    expect(first).toMatchObject({ records: 2, changed: 2, indexed: 2, removed: 0 });
    const again = await sweepBrand(ctx, {}, { store, embed: unitEmbed, read: reader([src("idea", "i1", "Repot in spring"), src("note", "n1", "Fans love citrus")], ["idea", "note"]) });
    expect(again).toMatchObject({ changed: 0, indexed: 0 });
    expect(unitEmbed).toHaveBeenCalledTimes(2);
    const changed = await sweepBrand(ctx, {}, { store, embed: unitEmbed, read: reader([src("idea", "i1", "Repot in autumn"), src("note", "n1", "Fans love citrus")], ["idea", "note"]) });
    expect(changed).toMatchObject({ changed: 1, indexed: 1 });
    expect((await store.words("autumn", { limit: 5 })).length).toBe(1);
  });

  it("rolls back a rename: an idea_board entry is removed, chunks too, and indexed again as idea", async () => {
    const index = new MemorySearchIndex();
    const store = index.storeFor(ctx);
    // What 0b would have written, then reverted: a manifest and chunks stored as idea_board.
    const stored = (n: number) => ({
      tenantId: ctx.tenantId,
      kind: "idea_board",
      ref: "i1",
      sourceKey: "idea_board:i1",
      chunk: n,
      title: "i1",
      text: `Repot in spring ${n}`,
      url: "",
      lang: "en",
      updatedAt: "2026-11-20T10:00:00.000Z",
      embedding: [1, 0, 0],
    });
    const manifest = { sourceKey: "idea_board:i1", kind: "idea_board", ref: "i1", hash: "h", chunks: 2, embedded: true, indexedAt: "2026-11-20T10:00:00.000Z", version: "v0" };
    await store.putSource(manifest as unknown as SearchManifest, [stored(0), stored(1)] as unknown as SearchChunkDoc[], 0);
    // Before the sweep it is still found, as an idea.
    expect((await store.words("repot", { limit: 5, kinds: ["idea"] })).map((h) => h.kind)).toEqual(["idea", "idea"]);

    const c = await sweepBrand(ctx, {}, { store, embed: unitEmbed, read: reader([src("idea", "i1", "Repot in spring")], ["idea"]) });
    expect(c).toMatchObject({ removed: 1, indexed: 1 });
    expect(await store.getManifest("idea_board:i1")).toBeNull();
    expect([...(index.chunks.get(ctx.tenantId)?.values() ?? [])].map((x) => x.sourceKey)).toEqual(["idea:i1"]);
    expect(await store.getManifest("idea:i1")).toMatchObject({ kind: "idea", ref: "i1" });
  });

  it("removes what is gone, but only for kinds read in full", async () => {
    const index = new MemorySearchIndex();
    const store = index.storeFor(ctx);
    await sweepBrand(ctx, {}, { store, embed: unitEmbed, read: reader([src("idea", "i1", "a"), src("note", "n1", "b")], ["idea", "note"]) });
    // The note read failed (not complete) and the idea is gone.
    const c = await sweepBrand(ctx, {}, { store, embed: unitEmbed, read: reader([], ["idea"]) });
    expect(c.removed).toBe(1);
    expect(await store.getManifest("idea:i1")).toBeNull();
    expect(await store.getManifest("note:n1")).not.toBeNull();
  });

  it("tries text kept without vectors again only after a while", async () => {
    const index = new MemorySearchIndex();
    const store = index.storeFor(ctx);
    const noVectors = vi.fn(async (items: unknown[]) => items.map(() => null));
    const read = reader([src("idea", "i1", "a")], ["idea"]);
    const t0 = Date.parse("2026-11-17T10:00:00Z");
    await sweepBrand(ctx, {}, { store, embed: noVectors, read, clock: () => t0 });
    const soon = await sweepBrand(ctx, {}, { store, embed: noVectors, read, clock: () => Date.now() + 60_000 });
    expect(soon.changed).toBe(0);
    const later = await sweepBrand(ctx, {}, { store, embed: unitEmbed, read, clock: () => Date.now() + 7 * 3600_000 });
    expect(later).toMatchObject({ changed: 1, indexed: 1 });
    expect((await store.getManifest("idea:i1"))?.embedded).toBe(true);
  });

  it("changes nothing on a dry run", async () => {
    const index = new MemorySearchIndex();
    const store = index.storeFor(ctx);
    const c = await sweepBrand(ctx, { dryRun: true }, { store, embed: unitEmbed, read: reader([src("idea", "i1", "a")], ["idea"]) });
    expect(c).toMatchObject({ records: 1, changed: 1, indexed: 0 });
    expect(unitEmbed).not.toHaveBeenCalled();
    expect(await store.listManifests()).toEqual([]);
  });

  it("stops at the deadline and carries on next time", async () => {
    const index = new MemorySearchIndex();
    const store = index.storeFor(ctx);
    let now = 0;
    const embed = vi.fn(async (items: unknown[]) => {
      now += 1000;
      return items.map(() => [1, 0, 0]);
    });
    const read = reader([src("idea", "a", "x"), src("idea", "b", "y"), src("idea", "c", "z")], ["idea"]);
    const first = await sweepBrand(ctx, { deadlineMs: 1500 }, { store, embed, read, clock: () => now });
    expect(first.partial).toBe(true);
    expect(first.indexed).toBe(2);
    const second = await sweepBrand(ctx, { deadlineMs: 99_999 }, { store, embed, read, clock: () => now });
    expect(second).toMatchObject({ changed: 1, indexed: 1, partial: false });
  });
});

describe("runSearchSweeps", () => {
  afterEach(() => vi.unstubAllEnvs());
  const tenant = (id: string, grantedFeatures: string[] = []) => ({ id, region: "us", grantedFeatures }) as never;

  it("does nothing while off, or between sweep ticks", async () => {
    const listTenants = vi.fn(async () => [tenant("ten_a")]);
    expect((await runSearchSweeps({ deadlineMs: 1e12 }, { listTenants, clock: () => 0 })).scanned).toBe(false);
    vi.stubEnv("SEARCH_INDEX_ENABLED", "true");
    expect(isSweepTick(120_000)).toBe(false);
    expect((await runSearchSweeps({ deadlineMs: 1e12 }, { listTenants, clock: () => 120_000 })).scanned).toBe(false);
    expect(listTenants).not.toHaveBeenCalled();
  });

  it("checks only brands granted search when the deployment keeps it for some", async () => {
    vi.stubEnv("SEARCH_INDEX_ENABLED", "true");
    vi.stubEnv("GRANTED_ONLY_FEATURES", "brand_search");
    const index = new MemorySearchIndex();
    const read = vi.fn(async (_ctx: { tenantId: string }) => ({ stubs: [], complete: new Set<SearchKind>() }));
    const r = await runSearchSweeps(
      { deadlineMs: 1e12 },
      { listTenants: async () => [tenant("ten_a", ["brand_search"]), tenant("ten_b")], clock: () => 0, read, store: index.storeFor({ tenantId: "ten_a" }) },
    );
    expect(r).toMatchObject({ scanned: true, swept: 1 });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[0]).toMatchObject({ tenantId: "ten_a" });
  });
});
