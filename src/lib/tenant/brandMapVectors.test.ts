import { describe, expect, it } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import type { KnowledgeCollectionLike, TenantContext } from "./types";
import {
  BRAND_MAP_VECTORS,
  brandMapVectorDocId,
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
