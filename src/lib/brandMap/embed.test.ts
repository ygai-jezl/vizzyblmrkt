import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
// Writers that pass no store reach brand search through this in-memory index (ADR-0025).
vi.mock("@/lib/tenant/searchIndex", async (original) => (await import("@/lib/search/testing/memorySearch")).withMemorySearch(await original<object>()));
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { KnowledgeCollectionLike, TenantContext } from "@/lib/tenant/types";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import { BRAND_MAP_VECTORS, brandMapVectorDocId } from "@/lib/tenant/brandMapVectors";
import { MemorySearchIndex } from "@/lib/search/memoryStore";
import { brandMapStubs } from "@/lib/search/feeders";
import { indexSource } from "@/lib/search/indexer";
import { embedSubjects, LOOKS_LIKE, nearestSituations, nearestSubjects, nearestSubjectsMany, subjectText } from "./embed";
import { ensureMoved } from "./move";
import { addQuestion, createSubject } from "./records";
import { createSituation } from "./situations";
import { fileSuggestions } from "./filing";
import { proposedQuestion } from "./proposals";
import { withdrawProposedBy } from "@/lib/connectors/signals/reconcile";

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

  it("for placing, lets the rest of a small map follow the ones sharing a word, when meaning can't be had", async () => {
    const db = new FakeFirestore();
    await ensureMoved(ctx, { db, nowMs: NOW });
    for (const name of ["AI Overviews and click-through", "Citation gaps", "GEO audits"]) await createSubject(ctx, { name }, { db, nowMs: NOW });
    const name = async (ids: string[]) => (await brandMapRecords(ctx, db).getMany("sub", ids)).map((s) => s.name);
    const placing = await nearestSubjects(ctx, "Our board asked how often AI Overviews name us", { limit: 25, fill: true }, { db, query: async () => null });
    expect(await name(placing.map((n) => n.ref))).toEqual(expect.arrayContaining(["AI Overviews and click-through", "Citation gaps", "GEO audits"]));
    expect(await name([placing[0]!.ref])).toEqual(["AI Overviews and click-through"]);
    // Without it, only what shares a word.
    expect(await nearestSubjects(ctx, "Our board asked how often AI Overviews name us", { limit: 25 }, { db, query: async () => null })).toHaveLength(1);
    const many = await nearestSubjectsMany(ctx, ["What should our board see?"], { limit: 25, fill: true }, { db, embed: async (items) => items.map(() => null) });
    expect(many[0]).toHaveLength(3);
  });
});

describe("the map's meaning in brand search (ADR-0025)", () => {
  beforeEach(() => {
    vi.stubEnv("SEARCH_INDEX_ENABLED", "true");
    vi.stubEnv("SEARCH_FAMILY_INDEX_ENABLED", "true");
  });

  const unit = (v: number[]) => {
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
  };
  /** gemini-embedding-001 as a test sees it: figs point one way, citations another. */
  const fresh = () =>
    vi.fn(async (items: Array<{ content: string; title?: string }>, _region: string, _task: string) =>
      items.map((i) => (/fig/i.test(i.content) ? unit([1, 0.05, 0]) : /citation/i.test(i.content) ? unit([0, 1, 0]) : unit([0, 0, 1]))),
    );
  /** text-embedding-005: a vector no brand search record ever has. */
  const OLD = [0, 0, 0, 1];
  const oldModel = { embed: async (items: Array<{ content: string }>) => items.map(() => OLD), query: async () => OLD };
  /** The old store's search: records each call, so a test can say it was never asked. */
  const oldSearch = () => {
    const calls: unknown[] = [];
    const self: KnowledgeCollectionLike = {
      where: () => self,
      findNearest: (opts) => {
        calls.push(opts);
        return { get: async () => ({ empty: true, size: 0, docs: [] }) };
      },
    };
    return { self, calls };
  };

  async function mapWithFigs() {
    const db = new FakeFirestore();
    await ensureMoved(ctx, { db, nowMs: NOW });
    const made = await createSubject(ctx, { name: "Repotting figs" }, { db, nowMs: NOW });
    const id = made.ok ? made.value.id : "";
    await addQuestion(ctx, id, { text: "When do I repot a fig?" }, { db, nowMs: NOW });
    return { db, id };
  }

  it("writes both stores, and the index gets the text the sweep makes, with the status", async () => {
    const { db, id } = await mapWithFigs();
    const search = new MemorySearchIndex().storeFor(ctx);
    const embedSearch = fresh();
    expect(await embedSubjects(ctx, [id], { db, ...oldModel, vectors: oldSearch().self, search, embedSearch })).toBe(1);
    expect(db.raw(BRAND_MAP_VECTORS, brandMapVectorDocId("ten_A", "subject", id))).toMatchObject({ status: "decided" });
    expect(await search.getManifest(`subject:${id}`)).toMatchObject({ status: "decided", chunks: 1 });
    // The same text from the sweep's read of the map and from write-through, so nothing is embedded twice.
    const [swept] = await brandMapStubs(brandMapRecords(ctx, db), [], { family: true });
    expect(swept?.ref).toBe(id);
    const fromSweep = await swept!.load();
    await indexSource(ctx, fromSweep!, { store: search, embed: embedSearch, granted: true });
    expect(embedSearch).toHaveBeenCalledTimes(1);
    expect(embedSearch.mock.calls[0]![0]).toEqual([{ content: "Repotting figs\n\nWhen do I repot a fig?", title: "Repotting figs" }]);
    expect(embedSearch.mock.calls[0]![2]).toBe("RETRIEVAL_DOCUMENT");
  });

  it("checks 'looks like' on brand search with reads on, and never asks the old store or gives it a new vector", async () => {
    vi.stubEnv("SEARCH_SUBJECT_READS_ENABLED", "true");
    const { db, id } = await mapWithFigs();
    const search = new MemorySearchIndex().storeFor(ctx);
    const old = oldSearch();
    const embedSearch = fresh();
    await embedSubjects(ctx, [id], { db, ...oldModel, vectors: old.self, search, embedSearch });
    await fileSuggestions(ctx, { from: "research", items: [{ change: { type: "add_subject", name: "Fig repotting" } }] }, { db, nowMs: NOW });
    const [proposal] = await brandMapRecords(ctx, db).find("sub", { where: [["status", "==", "proposed"]] });
    await embedSubjects(ctx, [proposal!.id], { db, ...oldModel, vectors: old.self, search, embedSearch });
    expect(await brandMapRecords(ctx, db).get("sub", proposal!.id)).toMatchObject({ status: "proposed", looksLike: id });
    expect(old.calls).toEqual([]);
    // brand_map_vectors only ever holds the old model's vectors.
    const stored = db.raw(BRAND_MAP_VECTORS, brandMapVectorDocId("ten_A", "subject", proposal!.id));
    expect(JSON.stringify(stored?.embedding)).toContain(JSON.stringify(OLD).slice(1, -1));

    // The same fixtures with reads off: the old store decides (here it finds nothing near).
    vi.stubEnv("SEARCH_SUBJECT_READS_ENABLED", "false");
    await embedSubjects(ctx, [proposal!.id], { db, ...oldModel, vectors: old.self, search, embedSearch });
    expect(old.calls).toHaveLength(1);
    expect(await brandMapRecords(ctx, db).get("sub", proposal!.id)).toMatchObject({ looksLike: null });
  });

  it("marks 'looks like' at the cut-off of the store the readers use, switch off and on", async () => {
    // Two different values, so a check wired to the other store's cut-off can't pass.
    const was = { ...LOOKS_LIKE };
    Object.assign(LOOKS_LIKE, { old: 0.95, new: 0.75 });
    onTestFinished(() => void Object.assign(LOOKS_LIKE, was));
    const { db, id } = await mapWithFigs();
    const search = new MemorySearchIndex().storeFor(ctx);
    // On brand search the proposal sits at 0.8 from the subject; on brand_map_vectors at 0.85.
    const embedSearch = vi.fn(async (items: Array<{ content: string }>) => items.map((i) => (/^Fig repotting/.test(i.content) ? [0.8, 0.6, 0] : [1, 0, 0])));
    const near = vectors([{ tenantId: "ten_A", kind: "subject", ref: id, status: "decided", _distance: 0.15 }]);
    await embedSubjects(ctx, [id], { db, ...oldModel, vectors: near, search, embedSearch });
    await fileSuggestions(ctx, { from: "research", items: [{ change: { type: "add_subject", name: "Fig repotting" } }] }, { db, nowMs: NOW });
    const [proposal] = await brandMapRecords(ctx, db).find("sub", { where: [["status", "==", "proposed"]] });
    const looksLike = async () => (await brandMapRecords(ctx, db).get("sub", proposal!.id))?.looksLike ?? null;

    // Off: 0.85 is under the old cut-off.
    await embedSubjects(ctx, [proposal!.id], { db, ...oldModel, vectors: near, search, embedSearch });
    expect(await looksLike()).toBeNull();
    // On: 0.8 clears the new one.
    vi.stubEnv("SEARCH_SUBJECT_READS_ENABLED", "true");
    await embedSubjects(ctx, [proposal!.id], { db, ...oldModel, vectors: near, search, embedSearch });
    expect(await looksLike()).toBe(id);
  });

  it("reads nearest subjects and situations from brand search with each reader's task type", async () => {
    vi.stubEnv("SEARCH_SUBJECT_READS_ENABLED", "true");
    const { db, id } = await mapWithFigs();
    const search = new MemorySearchIndex().storeFor(ctx);
    const embedSearch = fresh();
    await embedSubjects(ctx, [id], { db, ...oldModel, search, embedSearch });
    const sit = await createSituation(ctx, { text: "My fig has outgrown its pot" }, { db, nowMs: NOW, embed: { ...oldModel, search, embedSearch } });
    const old = oldSearch();
    const query = vi.fn(async () => OLD);
    const deps = { db, embed: oldModel.embed, query, vectors: old.self, search, embedSearch };
    embedSearch.mockClear();

    expect((await nearestSubjects(ctx, "Why won't my fig grow?", { limit: 3 }, deps)).map((n) => n.ref)).toEqual([id]);
    expect(embedSearch.mock.calls[0]?.[0]).toEqual([{ content: "Why won't my fig grow?" }]);
    expect(embedSearch.mock.calls[0]?.[2]).toBe("RETRIEVAL_QUERY");

    const many = await nearestSubjectsMany(ctx, ["repot fig"], { limit: 3 }, deps);
    expect(many[0]?.map((n) => n.ref)).toEqual([id]);
    expect(embedSearch.mock.calls[1]?.[0]).toEqual([{ content: "repot fig", title: "Question" }]);
    expect(embedSearch.mock.calls[1]?.[2]).toBe("RETRIEVAL_DOCUMENT");

    expect((await nearestSituations(ctx, "Which pot for a fig?", { limit: 3 }, deps)).map((n) => n.ref)).toEqual([sit.ok ? sit.value.id : ""]);
    expect(embedSearch.mock.calls[2]?.[2]).toBe("RETRIEVAL_QUERY");
    expect(query).not.toHaveBeenCalled();
    expect(old.calls).toEqual([]);
  });

  it("falls back to shared words for subjects, and finds no situation, when brand search can't answer", async () => {
    vi.stubEnv("SEARCH_SUBJECT_READS_ENABLED", "true");
    const { db } = await mapWithFigs();
    const broken = { ...new MemorySearchIndex().storeFor(ctx), nearest: async () => Promise.reject(new Error("unavailable")) };
    const deps = { db, search: broken, embedSearch: fresh() };
    const words = await nearestSubjects(ctx, "How do I start repotting figs?", { limit: 3 }, deps);
    expect(await brandMapRecords(ctx, db).getMany("sub", words.map((n) => n.ref))).toMatchObject([{ name: "Repotting figs" }]);
    expect(await nearestSituations(ctx, "Which pot for a fig?", { limit: 3 }, deps)).toEqual([]);
  });

  it("embeds nothing for brand_map_vectors once it is retired, and keeps writing brand search", async () => {
    for (const k of ["SEARCH_SUBJECT_READS_ENABLED", "SEARCH_NOTE_READS_ENABLED", "SEARCH_COMPETITOR_READS_ENABLED", "SEARCH_OLD_VECTORS_RETIRED_ENABLED"]) vi.stubEnv(k, "true");
    const { db, id } = await mapWithFigs();
    const search = new MemorySearchIndex().storeFor(ctx);
    const embed = vi.fn(oldModel.embed);
    expect(await embedSubjects(ctx, [id], { db, embed, search, embedSearch: fresh() })).toBe(1);
    expect(embed).not.toHaveBeenCalled();
    expect(db.raw(BRAND_MAP_VECTORS, brandMapVectorDocId("ten_A", "subject", id))).toBeUndefined();
    expect(await search.getManifest(`subject:${id}`)).toMatchObject({ status: "decided" });
  });

  it("keeps a search a connection proposed out of its subject's text, so erasing the connection leaves none of it in brand search", async () => {
    const { db, id } = await mapWithFigs();
    const index = new MemorySearchIndex();
    const search = index.storeFor(ctx);
    const store = brandMapRecords(ctx, db);
    const connection = "dcn_aaaaaaaaaaaaaaaaaaaa";
    const now = new Date(NOW).toISOString();
    await proposedQuestion(ctx, store, { subjectId: id, text: "fig repotting soil mix", from: "search_console", reason: "Rising search", evidence: "fig repotting soil mix", now, fromConnectionId: connection, order: 1 });
    await proposedQuestion(ctx, store, { subjectId: id, text: "Which pot suits a fig?", from: "research", reason: "Research", evidence: "", now, order: 2 });
    const text = () => [...(index.chunks.get("ten_A")?.values() ?? [])].filter((c) => c.ref === id).map((c) => c.text).join("\n");

    await embedSubjects(ctx, [id], { db, ...oldModel, vectors: oldSearch().self, search, embedSearch: fresh() });
    // A decided subject is shown to people: neither proposal is in its text, the search least of all.
    expect(text()).toBe("Repotting figs\n\nWhen do I repot a fig?");
    const [swept] = await brandMapStubs(store, [], { family: true });
    expect((await swept!.load())?.body).toBe(text());

    // Erasing the connection withdraws its question and rewrites no subject: there was nothing to take out.
    expect(await withdrawProposedBy(ctx, connection, "all", { db })).toBe(1);
    expect(text()).not.toContain("soil mix");
  });

  it("leaves brand search alone while the family switch is off", async () => {
    vi.stubEnv("SEARCH_FAMILY_INDEX_ENABLED", "false");
    const { db, id } = await mapWithFigs();
    const search = new MemorySearchIndex().storeFor(ctx);
    const embedSearch = fresh();
    expect(await embedSubjects(ctx, [id], { db, ...oldModel, vectors: oldSearch().self, search, embedSearch })).toBe(1);
    expect(embedSearch).not.toHaveBeenCalled();
    expect(await search.listManifests()).toEqual([]);
  });
});
