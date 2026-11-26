import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import type { KnowledgeCollectionLike, TenantContext } from "./types";
import {
  BRAND_MAP_VECTORS,
  brandMapVectorDocId,
  countBrandMapVectors,
  deleteBrandMapVectors,
  listBrandMapVectorRefs,
  nearestBrandMapRecords,
  removeBrandMapVector,
  setBrandMapVectorStatus,
  writeBrandMapVector,
} from "./brandMapVectors";

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken" };
const B: TenantContext = { tenantId: "ten_B", region: "us", source: "idtoken" };

/** A vector collection that returns these rows as the search's answer, recording the filters it was given. */
function fakeVectors(rows: Array<Record<string, unknown>>) {
  const filters: Array<[string, unknown]> = [];
  const asked: { limit?: number } = {};
  const self: KnowledgeCollectionLike = {
    where: (field, _op, value) => {
      filters.push([field, value]);
      return self;
    },
    findNearest: (opts) => {
      asked.limit = opts.limit;
      return { get: async () => ({ empty: rows.length === 0, size: rows.length, docs: rows.map((d, i) => ({ id: `v${i}`, data: () => d })) }) };
    },
  };
  return { self, filters, asked };
}

describe("the brand map's embeddings", () => {
  it("are stored per brand, kind and record, with the record's status", async () => {
    const db = new FakeFirestore();
    await writeBrandMapVector(A, { kind: "subject", ref: "sub_aaaaaaaa", status: "proposed" }, [0.1, 0.2], db);
    const id = brandMapVectorDocId("ten_A", "subject", "sub_aaaaaaaa");
    expect(id).not.toBe(brandMapVectorDocId("ten_B", "subject", "sub_aaaaaaaa"));
    expect(id).not.toBe(brandMapVectorDocId("ten_A", "situation", "sub_aaaaaaaa"));
    expect(db.raw(BRAND_MAP_VECTORS, id)).toMatchObject({ tenantId: "ten_A", kind: "subject", ref: "sub_aaaaaaaa", status: "proposed" });

    await setBrandMapVectorStatus(A, { kind: "subject", ref: "sub_aaaaaaaa", status: "decided" }, db);
    expect(db.raw(BRAND_MAP_VECTORS, id)?.status).toBe("decided");
    await removeBrandMapVector(B, "subject", "sub_aaaaaaaa", db);
    expect(db.raw(BRAND_MAP_VECTORS, id)).toBeDefined();
    await removeBrandMapVector(A, "subject", "sub_aaaaaaaa", db);
    expect(db.raw(BRAND_MAP_VECTORS, id)).toBeUndefined();
  });

  it("finds the nearest of a kind on the map, most similar first, and nothing of another brand's", async () => {
    const { self, filters, asked } = fakeVectors([
      { tenantId: "ten_A", kind: "subject", ref: "sub_far", status: "decided", _distance: 0.6 },
      { tenantId: "ten_A", kind: "subject", ref: "sub_near", status: "decided", _distance: 0.1 },
      { tenantId: "ten_A", kind: "subject", ref: "sub_proposed", status: "proposed", _distance: 0.05 },
      { tenantId: "ten_B", kind: "subject", ref: "sub_other", status: "decided", _distance: 0 },
      { tenantId: "ten_A", kind: "situation", ref: "sit_x", status: "decided", _distance: 0 },
    ]);
    const near = await nearestBrandMapRecords(A, { kind: "subject", vector: [1, 0], limit: 5 }, self);
    expect(near.map((n) => n.ref)).toEqual(["sub_near", "sub_far"]);
    expect(near[0]!.sim).toBeCloseTo(0.9);
    expect(filters).toContainEqual(["kind", "subject"]);
    expect(asked.limit).toBe(10);

    const withProposals = await nearestBrandMapRecords(A, { kind: "subject", vector: [1, 0], limit: 1, statuses: ["decided", "proposed"], minSim: 0.5 }, self);
    expect(withProposals.map((n) => n.ref)).toEqual(["sub_proposed"]);
  });
});

describe("retiring the store (ADR-0025)", () => {
  afterEach(() => vi.unstubAllEnvs());
  const retire = (reads: string[]) => {
    for (const k of ["SEARCH_INDEX_ENABLED", "SEARCH_FAMILY_INDEX_ENABLED", "SEARCH_OLD_VECTORS_RETIRED_ENABLED", ...reads]) vi.stubEnv(k, "true");
  };

  it("stops writes and status updates only with the retire switch and all three read switches on, and keeps removals", async () => {
    const db = new FakeFirestore();
    const id = brandMapVectorDocId("ten_A", "subject", "sub_1");
    retire(["SEARCH_SUBJECT_READS_ENABLED", "SEARCH_NOTE_READS_ENABLED"]);
    await writeBrandMapVector(A, { kind: "subject", ref: "sub_1", status: "proposed" }, [0.1], db);
    expect(db.raw(BRAND_MAP_VECTORS, id)).toMatchObject({ status: "proposed" });

    retire(["SEARCH_SUBJECT_READS_ENABLED", "SEARCH_NOTE_READS_ENABLED", "SEARCH_COMPETITOR_READS_ENABLED"]);
    await writeBrandMapVector(A, { kind: "subject", ref: "sub_2", status: "decided" }, [0.1], db);
    expect(db.raw(BRAND_MAP_VECTORS, brandMapVectorDocId("ten_A", "subject", "sub_2"))).toBeUndefined();
    await setBrandMapVectorStatus(A, { kind: "subject", ref: "sub_1", status: "decided" }, db);
    expect(db.raw(BRAND_MAP_VECTORS, id)?.status).toBe("proposed");
    await removeBrandMapVector(A, "subject", "sub_1", db);
    expect(db.raw(BRAND_MAP_VECTORS, id)).toBeUndefined();
  });

  it("counts and deletes one brand's vectors of a kind, never another brand's or kind's", async () => {
    const db = new FakeFirestore();
    for (let i = 0; i < 305; i++) await writeBrandMapVector(A, { kind: "note", ref: `bn_${i}`, status: "kept" }, [0.1], db);
    await writeBrandMapVector(A, { kind: "subject", ref: "sub_1", status: "decided" }, [0.1], db);
    await writeBrandMapVector(B, { kind: "note", ref: "bn_x", status: "kept" }, [0.1], db);
    expect(await countBrandMapVectors(A, "note", db)).toBe(305);
    // Listed a page at a time, refs only.
    const refs = await listBrandMapVectorRefs(A, "note", db);
    expect(refs).toHaveLength(305);
    expect(new Set(refs).size).toBe(305);
    expect(refs).not.toContain("bn_x");
    expect(await deleteBrandMapVectors(A, "note", db)).toBe(305);
    expect(await countBrandMapVectors(A, "note", db)).toBe(0);
    expect(await countBrandMapVectors(A, "subject", db)).toBe(1);
    expect(await countBrandMapVectors(B, "note", db)).toBe(1);
  });
});

