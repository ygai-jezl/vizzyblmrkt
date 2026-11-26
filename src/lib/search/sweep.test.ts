import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubOf } from "./feeders";
import { MemorySearchIndex } from "./memoryStore";
import { FAMILY_TURNS, isFamilyTurn, isSweepTick, runSearchSweeps, sweepBrand } from "./sweep";
import type { SearchKind, SearchSource, SearchStore } from "./types";

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
    vi.stubEnv("SEARCH_KIND_IDEA_BOARD_ENABLED", "true");
    unitEmbed.mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("indexes new records, skips unchanged ones and re-indexes changed ones", async () => {
    const index = new MemorySearchIndex();
    const store = index.storeFor(ctx);
    const first = await sweepBrand(ctx, {}, { store, embed: unitEmbed, read: reader([src("idea_board", "i1", "Repot in spring"), src("note", "n1", "Fans love citrus")], ["idea_board", "note"]) });
    expect(first).toMatchObject({ records: 2, changed: 2, indexed: 2, removed: 0 });
    const again = await sweepBrand(ctx, {}, { store, embed: unitEmbed, read: reader([src("idea_board", "i1", "Repot in spring"), src("note", "n1", "Fans love citrus")], ["idea_board", "note"]) });
    expect(again).toMatchObject({ changed: 0, indexed: 0 });
    expect(unitEmbed).toHaveBeenCalledTimes(2);
    const changed = await sweepBrand(ctx, {}, { store, embed: unitEmbed, read: reader([src("idea_board", "i1", "Repot in autumn"), src("note", "n1", "Fans love citrus")], ["idea_board", "note"]) });
    expect(changed).toMatchObject({ changed: 1, indexed: 1 });
    expect((await store.words("autumn", { limit: 5 })).length).toBe(1);
  });

  // What one record holds in the store, under the name it is stored as.
  const raw = (index: MemorySearchIndex) => ({
    manifests: [...(index.manifests.get(ctx.tenantId)?.values() ?? [])].map((m) => `${m.kind} ${m.sourceKey}`),
    chunks: [...(index.chunks.get(ctx.tenantId)?.values() ?? [])].map((c) => `${c.kind} ${c.sourceKey}`),
  });
  // An Idea Board item stored with two chunks under `name`.
  const seedIdea = async (store: SearchStore, name: "idea" | "idea_board") => {
    const sourceKey = `${name}:i1`;
    const stored = (n: number) => ({ tenantId: ctx.tenantId, kind: name, ref: "i1", sourceKey, chunk: n, title: "i1", text: `Repot in spring ${n}`, url: "", lang: "en", updatedAt: "2026-11-20T10:00:00.000Z", embedding: [1, 0, 0] });
    await store.putSource({ sourceKey, kind: name, ref: "i1", hash: "h", chunks: 2, embedded: true, indexedAt: "2026-11-20T10:00:00.000Z", version: "v0" }, [stored(0), stored(1)], 0);
  };
  const ideaRead = () => reader([src("idea_board", "i1", "Repot in spring")], ["idea_board"]);

  it("moves an Idea Board item stored as idea to idea_board when the switch is on", async () => {
    const index = new MemorySearchIndex();
    const store = index.storeFor(ctx);
    await seedIdea(store, "idea");
    // Before the check it is found, as idea_board.
    expect((await store.words("repot", { limit: 5, kinds: ["idea_board"] })).map((h) => h.kind)).toEqual(["idea_board", "idea_board"]);

    const c = await sweepBrand(ctx, {}, { store, embed: unitEmbed, read: ideaRead() });
    expect(c).toMatchObject({ removed: 1, indexed: 1 });
    expect(await store.getManifest("idea:i1")).toBeNull();
    expect(raw(index)).toEqual({ manifests: ["idea_board idea_board:i1"], chunks: ["idea_board idea_board:i1"] });
    expect(await store.getManifest("idea_board:i1")).toMatchObject({ kind: "idea_board", ref: "i1" });
    // The next check finds nothing to do.
    expect(await sweepBrand(ctx, {}, { store, embed: unitEmbed, read: ideaRead() })).toMatchObject({ changed: 0, removed: 0 });
  });

  it("keeps writing idea while the switch is off, and leaves an item stored as idea alone", async () => {
    vi.stubEnv("SEARCH_KIND_IDEA_BOARD_ENABLED", "false");
    const index = new MemorySearchIndex();
    const store = index.storeFor(ctx);
    const first = await sweepBrand(ctx, {}, { store, embed: unitEmbed, read: ideaRead() });
    expect(first).toMatchObject({ indexed: 1, removed: 0 });
    expect(raw(index)).toEqual({ manifests: ["idea idea:i1"], chunks: ["idea idea:i1"] });
    expect(await store.getManifest("idea:i1")).toMatchObject({ kind: "idea_board" });
    expect((await store.words("repot", { limit: 5, kinds: ["idea_board"] })).map((h) => h.kind)).toEqual(["idea_board"]);

    const again = await sweepBrand(ctx, {}, { store, embed: unitEmbed, read: ideaRead() });
    expect(again).toMatchObject({ changed: 0, removed: 0, indexed: 0 });
    expect(unitEmbed).toHaveBeenCalledTimes(1);
  });

  it("rolls back: with the switch off again, an idea_board entry is removed, chunks too, and indexed again as idea", async () => {
    vi.stubEnv("SEARCH_KIND_IDEA_BOARD_ENABLED", "false");
    const index = new MemorySearchIndex();
    const store = index.storeFor(ctx);
    await seedIdea(store, "idea_board");
    expect((await store.words("repot", { limit: 5, kinds: ["idea_board"] })).length).toBe(2);

    const c = await sweepBrand(ctx, {}, { store, embed: unitEmbed, read: ideaRead() });
    expect(c).toMatchObject({ removed: 1, indexed: 1 });
    expect(await store.getManifest("idea_board:i1")).toBeNull();
    expect(raw(index)).toEqual({ manifests: ["idea idea:i1"], chunks: ["idea idea:i1"] });
  });

  it("removes what is gone, but only for kinds read in full", async () => {
    const index = new MemorySearchIndex();
    const store = index.storeFor(ctx);
    await sweepBrand(ctx, {}, { store, embed: unitEmbed, read: reader([src("idea_board", "i1", "a"), src("note", "n1", "b")], ["idea_board", "note"]) });
    // The note read failed (not complete) and the idea is gone.
    const c = await sweepBrand(ctx, {}, { store, embed: unitEmbed, read: reader([], ["idea_board"]) });
    expect(c.removed).toBe(1);
    expect(await store.getManifest("idea_board:i1")).toBeNull();
    expect(await store.getManifest("note:n1")).not.toBeNull();
  });

  it("says which kinds it couldn't read, so a backfill counts them as failures", async () => {
    const store = new MemorySearchIndex().storeFor(ctx);
    const read = async () => ({ stubs: [stubOf(src("idea_board", "i1", "a"))], complete: new Set<SearchKind>(["idea_board"]), failed: new Set<SearchKind>(["subject", "note"]) });
    expect(await sweepBrand(ctx, {}, { store, embed: unitEmbed, read })).toMatchObject({ indexed: 1, failed: 0, unread: ["note", "subject"] });
    expect((await sweepBrand(ctx, {}, { store, embed: unitEmbed, read: reader([], ["idea_board"]) })).unread).toEqual([]);
  });

  it("tries text kept without vectors again only after a while", async () => {
    const index = new MemorySearchIndex();
    const store = index.storeFor(ctx);
    const noVectors = vi.fn(async (items: unknown[]) => items.map(() => null));
    const read = reader([src("idea_board", "i1", "a")], ["idea_board"]);
    const t0 = Date.parse("2026-11-17T10:00:00Z");
    await sweepBrand(ctx, {}, { store, embed: noVectors, read, clock: () => t0 });
    const soon = await sweepBrand(ctx, {}, { store, embed: noVectors, read, clock: () => Date.now() + 60_000 });
    expect(soon.changed).toBe(0);
    const later = await sweepBrand(ctx, {}, { store, embed: unitEmbed, read, clock: () => Date.now() + 7 * 3600_000 });
    expect(later).toMatchObject({ changed: 1, indexed: 1 });
    expect((await store.getManifest("idea_board:i1"))?.embedded).toBe(true);
  });

  it("changes nothing on a dry run", async () => {
    const index = new MemorySearchIndex();
    const store = index.storeFor(ctx);
    const c = await sweepBrand(ctx, { dryRun: true }, { store, embed: unitEmbed, read: reader([src("idea_board", "i1", "a")], ["idea_board"]) });
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
    const read = reader([src("idea_board", "a", "x"), src("idea_board", "b", "y"), src("idea_board", "c", "z")], ["idea_board"]);
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

describe("the brand map family's turn (ADR-0023)", () => {
  afterEach(() => vi.unstubAllEnvs());
  const tenant = (id: string, grantedFeatures: string[] = []) => ({ id, region: "us", grantedFeatures }) as never;
  const CHECK_MS = 600_000;

  it("comes once in 36 checks (about 6 hours) for each brand, at a check picked from its id", () => {
    for (const id of ["ten_a", "ten_b", "ten_fernleaf"]) {
      const turns = Array.from({ length: FAMILY_TURNS * 2 }, (_, i) => isFamilyTurn(id, i * CHECK_MS)).filter(Boolean);
      expect(turns).toHaveLength(2);
    }
    const slots = new Set(["ten_a", "ten_b", "ten_c", "ten_d", "ten_e", "ten_f"].map((id) => Array.from({ length: FAMILY_TURNS }, (_, i) => i).find((i) => isFamilyTurn(id, i * CHECK_MS))));
    expect(slots.size).toBeGreaterThan(1);
  });

  it("checks every brand with the family switch on: brands without search only on their turn, for the family only", async () => {
    vi.stubEnv("SEARCH_INDEX_ENABLED", "true");
    vi.stubEnv("SEARCH_FAMILY_INDEX_ENABLED", "true");
    vi.stubEnv("GRANTED_ONLY_FEATURES", "brand_search");
    const index = new MemorySearchIndex();
    const read = vi.fn(async (_ctx: { tenantId: string }, _opts: unknown) => ({ stubs: [], complete: new Set<SearchKind>() }));
    const tenants = [tenant("ten_granted", ["brand_search"]), tenant("ten_plain")];
    const turnOf = (id: string) => Array.from({ length: FAMILY_TURNS }, (_, i) => i * CHECK_MS).find((t) => isFamilyTurn(id, t))!;
    const sweep = (at: number) => runSearchSweeps({ deadlineMs: 1e15 }, { listTenants: async () => tenants, clock: () => at, read, store: index.storeFor({ tenantId: "x" }) });

    // On ten_plain's turn: both are checked, ten_plain for the family only, and first.
    const plainTurn = turnOf("ten_plain");
    expect(await sweep(plainTurn)).toMatchObject({ scanned: true, swept: 2 });
    expect(read.mock.calls.map(([c, o]) => [c.tenantId, o])).toEqual([
      ["ten_plain", { familyOnly: true, familyNow: true, kinds: undefined }],
      ["ten_granted", { familyOnly: false, familyNow: isFamilyTurn("ten_granted", plainTurn), kinds: undefined }],
    ]);

    // Off its turn: only the granted brand, which leaves the family for its own turn.
    read.mockClear();
    const off = Array.from({ length: FAMILY_TURNS }, (_, i) => i * CHECK_MS).find((t) => !isFamilyTurn("ten_plain", t) && !isFamilyTurn("ten_granted", t))!;
    expect(await sweep(off)).toMatchObject({ swept: 1 });
    expect(read.mock.calls.map(([c, o]) => [c.tenantId, o])).toEqual([["ten_granted", { familyOnly: false, familyNow: false, kinds: undefined }]]);

    // With the family switch off, as before: granted brands only, everything read.
    vi.stubEnv("SEARCH_FAMILY_INDEX_ENABLED", "false");
    read.mockClear();
    expect(await sweep(plainTurn)).toMatchObject({ swept: 1 });
    expect(read.mock.calls[0]?.[0]).toMatchObject({ tenantId: "ten_granted" });
  });

  it("indexes a brand without search for the family only, and leaves kinds not read alone", async () => {
    vi.stubEnv("SEARCH_INDEX_ENABLED", "true");
    vi.stubEnv("SEARCH_FAMILY_INDEX_ENABLED", "true");
    const index = new MemorySearchIndex();
    const store = index.storeFor(ctx);
    await store.putSource({ sourceKey: "article:old", kind: "article", ref: "old", hash: "h", chunks: 0, embedded: true, indexedAt: "" }, [], 0);
    const family: SearchSource[] = [
      { kind: "subject", ref: "sub_1", title: "Repotting figs", body: "Repotting figs", status: "decided" },
      { kind: "situation", ref: "sit_1", title: "Outgrown pot", body: "Outgrown pot", status: "proposed" },
    ];
    const c = await sweepBrand(ctx, { familyOnly: true, familyNow: true }, { store, embed: unitEmbed, read: reader(family, ["subject", "situation"]) });
    expect(c).toMatchObject({ indexed: 2, failed: 0, removed: 0 });
    expect(await store.getManifest("article:old")).not.toBeNull();
    expect((await store.getManifest("situation:sit_1"))?.status).toBe("proposed");
  });

  it("estimates what --apply would embed on a dry run, and what would only get its status", async () => {
    vi.stubEnv("SEARCH_INDEX_ENABLED", "true");
    vi.stubEnv("SEARCH_FAMILY_INDEX_ENABLED", "true");
    const index = new MemorySearchIndex();
    const store = index.storeFor(ctx);
    const note = { kind: "note" as const, ref: "bn_1", title: "We repot in spring", body: "We repot in spring" };
    await sweepBrand(ctx, {}, { store, embed: unitEmbed, read: reader([note], ["note"]) });
    unitEmbed.mockClear();
    const sources = [{ ...note, status: "kept" as const }, { kind: "subject" as const, ref: "sub_1", title: "Figs", body: "Figs", status: "decided" as const }];
    const dry = await sweepBrand(ctx, { dryRun: true, estimate: true }, { store, embed: unitEmbed, read: reader(sources, ["note", "subject"]) });
    expect(dry.estimate).toEqual({ chunks: 1, chars: 8, statusOnly: 1 });
    expect(unitEmbed).not.toHaveBeenCalled();
    // An indexed note with no status gets "kept" on the next check, with no embedding.
    const real = await sweepBrand(ctx, {}, { store, embed: unitEmbed, read: reader(sources, ["note", "subject"]) });
    expect(real).toMatchObject({ indexed: 1, unchanged: 1 });
    expect(unitEmbed).toHaveBeenCalledTimes(1);
    expect((await store.getManifest("note:bn_1"))?.status).toBe("kept");
  });
});

