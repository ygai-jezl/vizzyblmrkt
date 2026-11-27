import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

// The family-only read with the real readers (ADR-0025): a brand without brand_search, on its
// family turn, reads the brand map, notes and competitors from its own data, and only the family
// reaches the index. Every brand, name and site is made up.
const shared = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => shared.db,
}));
vi.mock("@/lib/tenant/searchIndex", () => ({
  searchStoreFor: () => {
    throw new Error("tests pass their own store");
  },
}));

const { forTenant } = await import("@/lib/tenant");
const { ensureMoved } = await import("@/lib/brandMap/move");
const { addQuestion, createSubject } = await import("@/lib/brandMap/records");
const { monitorCompetitor } = await import("@/lib/competitors/store");
const { readBrandStubs } = await import("./feeders");
const { MemorySearchIndex } = await import("./memoryStore");
const { sweepBrand } = await import("./sweep");

const A = { tenantId: "ten_fernleaf", region: "us" as const, source: "system" as const };
const NOW = Date.parse("2026-11-20T10:00:00.000Z");
const embed = vi.fn(async (items: unknown[]) => items.map(() => [1, 0, 0]));

beforeEach(() => {
  shared.db = new FakeFirestore();
  vi.stubEnv("SEARCH_INDEX_ENABLED", "true");
  vi.stubEnv("SEARCH_FAMILY_INDEX_ENABLED", "true");
  embed.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

/** A plant shop's map: a decided subject with a decided question of the map's own, and a competitor with a summary and one article read. */
async function plantShop() {
  const db = shared.db as FakeFirestore;
  await ensureMoved(A, { db, nowMs: NOW });
  const subject = await createSubject(A, { name: "Repotting figs" }, { db, nowMs: NOW });
  if (!subject.ok) throw new Error("no subject");
  const question = await addQuestion(A, subject.value.id, { text: "When do I repot a fig?" }, { db, nowMs: NOW });
  if (!question.ok) throw new Error("no question");
  const watched = await monitorCompetitor(A, { website: "leafy.example", name: "Leafy" }, { db });
  if (!watched.ok) throw new Error(watched.error);
  const competitorId = watched.value.competitor.id;
  // Only the summary matters to search; the rest of the analysis is left out.
  await forTenant(A, db).competitors.update(competitorId, { analysis: { summary: "A plant shop that writes care guides." } } as never);
  await forTenant(A, db).competitorArticles.create("art_repot", {
    competitorId,
    url: "https://leafy.example/blog/repot",
    title: "How to repot a fig",
    publishedAt: "2026-11-02",
    queuedAt: "2026-11-17T00:00:00.000Z",
    status: "read",
    summary: "When and how to move a fig to a bigger pot.",
    question: "When should I repot a fig?",
    angle: "Spring is best",
    subjectIds: [],
  } as never);
  return { subjectId: subject.value.id, questionId: question.value.id, competitorId };
}

describe("a brand without brand search, on its family turn", () => {
  it("reads only the family: never the map's own questions or a competitor's summary", async () => {
    const { subjectId, questionId, competitorId } = await plantShop();
    const { stubs, complete } = await readBrandStubs(A, { familyOnly: true, familyNow: true });
    expect(stubs.map((st) => `${st.kind}:${st.ref}`).sort()).toEqual([`competitor:${competitorId}/art_repot`, `subject:${subjectId}`]);
    expect(stubs.map((st) => st.ref)).not.toContain(questionId);
    expect(stubs.map((st) => st.ref)).not.toContain(competitorId);
    for (const k of ["subject", "question", "situation", "note", "competitor"] as const) expect(complete.has(k)).toBe(true);
  });

  it("takes out the map's own question and the competitor's summary left from when it had brand search, and fails nothing", async () => {
    const { subjectId, questionId, competitorId } = await plantShop();
    const store = new MemorySearchIndex().storeFor(A);
    const stale = (kind: "question" | "competitor", ref: string) =>
      store.putSource({ sourceKey: `${kind}:${ref}`, kind, ref, hash: "h", chunks: 0, embedded: true, indexedAt: "2026-11-01T00:00:00.000Z" }, [], 0);
    await stale("question", questionId);
    await stale("competitor", competitorId);

    const c = await sweepBrand(A, { familyOnly: true, familyNow: true }, { store, embed });
    expect(c).toMatchObject({ failed: 0, removed: 2, indexed: 2, unread: [] });
    expect(await store.getManifest(`question:${questionId}`)).toBeNull();
    expect(await store.getManifest(`competitor:${competitorId}`)).toBeNull();
    expect((await store.listManifests()).map((m) => `${m.sourceKey}:${m.status}`).sort()).toEqual([`competitor:${competitorId}/art_repot:kept`, `subject:${subjectId}:decided`]);
  });
});
