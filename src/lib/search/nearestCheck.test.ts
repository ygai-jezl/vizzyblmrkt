import { describe, expect, it } from "vitest";
import { MemorySearchIndex } from "./memoryStore";
import { checkSeeded, indexByKind, near, randomUnitVector, SEED_REFS, seedCheck, seededRandom, throwawayTenantId } from "./nearestCheck";

// scripts/search-nearest-check.ts's seed and checks, on the in-memory index (ADR-0023).

describe("the nearest check", () => {
  it("seeds a throwaway brand with one decided subject among 5,000 article and 5,000 proposed chunks, and passes", async () => {
    const rand = seededRandom(3);
    const index = new MemorySearchIndex();
    const tenantId = throwawayTenantId("ten_fernleaf", rand);
    expect(tenantId).toMatch(/^ten_fernleaf_qcheck_[0-9a-f]{8}$/);
    const store = index.storeFor({ tenantId });
    const subject = await seedCheck(store, tenantId, { dim: 48, rand, now: "2026-11-26T10:00:00.000Z" });
    expect(index.chunks.get(tenantId)?.size).toBe(10_001);
    expect(indexByKind(await store.listManifests())).toBe("article: 1 records, 5000 chunks; subject decided: 1 records, 1 chunks; subject proposed: 1 records, 5000 chunks");

    const r = await checkSeeded(store, async (kinds, vector, opts) => ({ hits: await store.nearest(kinds, vector, opts), explain: null }), subject, rand);
    expect(r).toMatchObject({ nearestFound: true, peopleFound: true, explain: null });
    expect(r.lines[1]).toContain("OK: the decided subject came first");
    // The throwaway path goes, and the brand's own index was never touched.
    expect(await store.clear()).toBe(10_001);
    expect(index.chunks.get("ten_fernleaf")).toBeUndefined();
  });

  it("fails when people's search shows a proposal", async () => {
    const rand = seededRandom(5);
    const store = new MemorySearchIndex().storeFor({ tenantId: "ten_x" });
    const subject = await seedCheck(store, "ten_x", { dim: 16, count: 50, rand, now: "2026-11-26T10:00:00.000Z" });
    const leaky = { ...store, meaning: async () => [{ id: "c", sourceKey: `subject:${SEED_REFS.proposals}`, kind: "subject" as const, ref: SEED_REFS.proposals, chunk: 0, title: "", text: "", url: "" }] };
    expect((await checkSeeded(leaky, async (k, v, o) => ({ hits: await store.nearest(k, v, o), explain: "x" }), subject, rand)).peopleFound).toBe(false);
  });

  it("makes unit vectors, and an article's vector close to its subject", () => {
    const rand = seededRandom(9);
    const v = randomUnitVector(64, rand);
    expect(Math.hypot(...v)).toBeCloseTo(1);
    const a = near(v, rand);
    expect(a.reduce((s, x, i) => s + x * v[i]!, 0)).toBeGreaterThan(0.95);
  });
});
