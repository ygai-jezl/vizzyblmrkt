import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { KnowledgeCollectionLike, TenantContext } from "@/lib/tenant/types";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import { BRAND_MAP_VECTORS, brandMapVectorDocId } from "@/lib/tenant/brandMapVectors";
import { embedSubjects, nearestSubjects, subjectText } from "./embed";
import { ensureMoved } from "./move";
import { addQuestion, createSubject } from "./records";
import { fileSuggestions } from "./filing";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "admin" };
const NOW = Date.parse("2026-10-15T10:00:00.000Z");

beforeEach(() => {
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_SCALE_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

/** A vector search that answers with these neighbours. */
const vectors = (rows: Array<Record<string, unknown>>): KnowledgeCollectionLike => {
  const self: KnowledgeCollectionLike = {
    where: () => self,
    findNearest: () => ({ get: async () => ({ empty: !rows.length, size: rows.length, docs: rows.map((d, i) => ({ id: `v${i}`, data: () => d })) }) }),
  };
  return self;
};

describe("the map's meaning", () => {
  it("embeds a subject by its name and first questions, with its status", async () => {
    const db = new FakeFirestore();
    await ensureMoved(ctx, { db, nowMs: NOW });
    const made = await createSubject(ctx, { name: "Share of voice" }, { db, nowMs: NOW });
    const id = made.ok ? made.value.id : "";
    await addQuestion(ctx, id, { text: "What is share of voice?" }, { db, nowMs: NOW });
    const embed = vi.fn(async (items: Array<{ content: string }>) => items.map(() => [1, 0, 0]));
    expect(await embedSubjects(ctx, [id], { db, embed })).toBe(1);
    expect(embed.mock.calls[0]![0]).toEqual([{ content: subjectText("Share of voice", ["What is share of voice?"]), title: "Subject" }]);
    expect(db.raw(BRAND_MAP_VECTORS, brandMapVectorDocId("ten_A", "subject", id))).toMatchObject({ kind: "subject", ref: id, status: "decided" });
  });

  it("marks a proposal that looks like a subject already on the map, and leaves the person to decide", async () => {
    const db = new FakeFirestore();
    await fileSuggestions(ctx, { from: "research", items: [{ change: { type: "add_subject", name: "Voice share" } }] }, { db, nowMs: NOW });
    const [proposal] = await brandMapRecords(ctx, db).find("sub", { where: [["status", "==", "proposed"]] });
    const near = vectors([{ tenantId: "ten_A", kind: "subject", ref: "sub_onmap0000", status: "decided", _distance: 0.04 }]);
    await embedSubjects(ctx, [proposal!.id], { db, embed: async (items) => items.map(() => [0, 1, 0]), vectors: near });
    expect(await brandMapRecords(ctx, db).get("sub", proposal!.id)).toMatchObject({ status: "proposed", looksLike: "sub_onmap0000" });
  });

  it("finds the nearest subjects by meaning, or by shared words when meaning can't be had", async () => {
    const db = new FakeFirestore();
    await ensureMoved(ctx, { db, nowMs: NOW });
    for (const name of ["AI Overviews and click-through", "Citation gaps", "GEO audits"]) await createSubject(ctx, { name }, { db, nowMs: NOW });
    const byMeaning = await nearestSubjects(ctx, "Why are my clicks falling?", { limit: 2 }, {
      db,
      query: async () => [1, 0],
      vectors: vectors([
        { tenantId: "ten_A", kind: "subject", ref: "sub_x00000001", status: "decided", _distance: 0.2 },
        { tenantId: "ten_A", kind: "subject", ref: "sub_x00000002", status: "decided", _distance: 0.4 },
      ]),
    });
    expect(byMeaning.map((n) => n.ref)).toEqual(["sub_x00000001", "sub_x00000002"]);
    const byWords = await nearestSubjects(ctx, "How do AI Overviews change click-through?", { limit: 2 }, { db, query: async () => null });
    const names = await brandMapRecords(ctx, db).getMany("sub", byWords.map((n) => n.ref));
    expect(names.map((s) => s.name)).toEqual(["AI Overviews and click-through"]);
  });
});
