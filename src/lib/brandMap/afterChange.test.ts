import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { KnowledgeCollectionLike, TenantContext } from "@/lib/tenant/types";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import { BRAND_MAP_VECTORS, brandMapVectorDocId } from "@/lib/tenant/brandMapVectors";
import { afterRecordsChange } from "./afterChange";
import { fileSuggestions } from "./filing";
import { ensureMoved } from "./move";
import { decideProposals } from "./proposals";
import { createSubject, mergeSubjects, removeSubject } from "./records";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "admin" };
const NOW = Date.parse("2026-10-15T10:00:00.000Z");
// A vector search with nothing near (a proposal "looks like" nothing).
const none: KnowledgeCollectionLike = {
  where: () => none,
  findNearest: () => ({ get: async () => ({ empty: true, size: 0, docs: [] }) }),
};
const works = { embed: async (items: Array<{ content: string }>) => items.map(() => [1, 0, 0]), vectors: none };
// An embeddings outage: no vectors come back.
const down = { embed: async (items: Array<{ content: string }>) => items.map(() => null), vectors: none };

beforeEach(() => {
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_SCALE_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

const vector = (db: FakeFirestore, id: string) => db.raw(BRAND_MAP_VECTORS, brandMapVectorDocId("ten_A", "subject", id));

describe("after a change to the map's records", () => {
  it("a subject's stored meaning follows its status even when embedding it again fails", async () => {
    const db = new FakeFirestore();
    await ensureMoved(ctx, { db, nowMs: NOW });
    await fileSuggestions(ctx, { from: "research", items: [{ change: { type: "add_subject", name: "Audits" } }] }, { db, nowMs: NOW });
    const [proposal] = await brandMapRecords(ctx, db).find("sub", { where: [["status", "==", "proposed"]] });
    await afterRecordsChange(ctx, { subjects: [proposal!.id] }, { db, nowMs: NOW, ...works });
    expect(vector(db, proposal!.id)).toMatchObject({ status: "proposed" });

    const r = await decideProposals(ctx, { accept: { subjects: [proposal!.id] } }, { db, nowMs: NOW });
    await afterRecordsChange(ctx, { subjects: r.touched, groups: r.groups }, { db, nowMs: NOW, ...down });
    // Found by an article's nearest lookup (decided only), though it wasn't embedded again.
    expect(vector(db, proposal!.id)).toMatchObject({ status: "decided" });
  });

  it("takes away the stored meaning of a subject dismissed, removed or merged away", async () => {
    const db = new FakeFirestore();
    await ensureMoved(ctx, { db, nowMs: NOW });
    const ids: string[] = [];
    for (const name of ["Share of voice", "Voice share", "Citations"]) {
      const made = await createSubject(ctx, { name }, { db, nowMs: NOW });
      ids.push(made.ok ? made.value.id : "");
    }
    await afterRecordsChange(ctx, { subjects: ids }, { db, nowMs: NOW, ...works });
    expect(ids.map((id) => Boolean(vector(db, id)))).toEqual([true, true, true]);

    const merged = await mergeSubjects(ctx, { from: ids[1]!, into: ids[0]! }, { db, nowMs: NOW });
    const removed = await removeSubject(ctx, ids[2]!, { db, nowMs: NOW });
    const touched = [...(merged.ok ? merged.touched : []), ...(removed.ok ? removed.touched : [])];
    await afterRecordsChange(ctx, { subjects: touched }, { db, nowMs: NOW, ...down });
    expect(ids.map((id) => Boolean(vector(db, id)))).toEqual([true, false, false]);
  });
});
