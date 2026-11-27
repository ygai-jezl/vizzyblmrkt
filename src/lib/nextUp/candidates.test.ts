import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { BrandMapDecidedSchema } from "@/lib/types/brandMap";
import { BrandMapPageFactsSchema, type BrandMapPage } from "@/lib/types/brandMapPage";
import { withDerivedFacts } from "@/lib/content/blog/pageRow";
import { saveBrandMap } from "@/lib/brandMap/store";
import { nextUpCandidates } from "./candidates";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import { questionKey, situationKey } from "@/lib/brandMap/keys";
import { StrategySchema } from "@/lib/types/brandStrategy";

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "admin" };

const DECIDED = BrandMapDecidedSchema.parse({
  identity: { name: "Acme" },
  subjects: [
    { id: "sub_aaaaaaaa", name: "Mostly done", questions: [
      { id: "q_aaaaaaa1", text: "What is share of voice?", intent: "definition" },
      { id: "q_aaaaaaa2", text: "How is it measured?", intent: "benchmarks" },
    ] },
    { id: "sub_bbbbbbbb", name: "Untouched", questions: [
      { id: "q_bbbbbbb1", text: "Why do AI answers cite some pages?", intent: "other" },
      { id: "q_bbbbbbb2", text: "How do I get cited?", intent: "how_to" },
    ] },
  ],
});

function row(id: string, over: Record<string, unknown>): BrandMapPage {
  const facts = withDerivedFacts(BrandMapPageFactsSchema.parse({ kind: "article", workspaceId: "ws1", planId: id, title: id, state: "draft", ...over }));
  return { ...facts, id, tenantId: "ten_A", fingerprint: `f_${id}`, updatedAt: "" };
}

beforeEach(() => {
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_PAGES_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("Next up's candidates on a small brand map", () => {
  it("offers open questions, least answered subjects first, taking turns, and leaves out what it's told to", async () => {
    const db = new FakeFirestore();
    await saveBrandMap(A, { baseRev: 0, decided: DECIDED }, { db, nowMs: Date.parse("2026-11-18T10:00:00.000Z") });
    db.seed("brand_map_pages", "p_a", row("p_a", { state: "live", primaryRef: "q_aaaaaaa1", url: "https://acme.example/a", liveAt: "2026-10-01T00:00:00.000Z", subjectId: "sub_aaaaaaaa" }) as never);
    const all = await nextUpCandidates(A, {}, { db });
    expect(all.map((c) => c.questionId)).toEqual(["q_bbbbbbb1", "q_aaaaaaa2", "q_bbbbbbb2"]);
    expect(all.find((c) => c.questionId === "q_aaaaaaa2")).toMatchObject({ answered: 1, total: 2, lastArticleAt: "2026-10-01T00:00:00.000Z" });
    const fewer = await nextUpCandidates(A, { exclude: new Set(["q_bbbbbbb1"]) }, { db });
    expect(fewer.map((c) => c.questionId)).toEqual(["q_bbbbbbb2", "q_aaaaaaa2"]);
    expect(await nextUpCandidates({ ...A, tenantId: "ten_B" }, {}, { db })).toEqual([]);
  });

  it("puts an approved strategy's focus questions first on a small map, whichever subject they are on", async () => {
    const db = new FakeFirestore();
    await saveBrandMap(A, { baseRev: 0, decided: DECIDED }, { db, nowMs: Date.parse("2026-11-18T10:00:00.000Z") });
    db.seed("brand_map_pages", "p_a", row("p_a", { state: "live", primaryRef: "q_aaaaaaa1", url: "https://acme.example/a", liveAt: "2026-10-01T00:00:00.000Z", subjectId: "sub_aaaaaaaa" }) as never);
    // The focus situation, and its question kept as a record (the map's list holds it too).
    const store = brandMapRecords(A, db);
    const text = "A client asks how it is measured";
    await store.create("sit", "sit_focus0001", { status: "decided", from: "person", text, textKey: situationKey(text), rev: 0, order: 0, createdAt: "", updatedAt: "" });
    await store.create("q", "q_aaaaaaa2", { status: "decided", from: "person", subjectId: "sub_aaaaaaaa", text: "How is it measured?", textKey: questionKey("How is it measured?"), situationIds: ["sit_focus0001"], rev: 0, createdAt: "", updatedAt: "" });
    const approved = StrategySchema.parse({ focusSituationIds: ["sit_focus0001"], at: "2026-11-25T10:00:00.000Z" });

    const without = await nextUpCandidates(A, {}, { db, strategy: async () => null });
    expect(without.map((c) => c.questionId)).toEqual(["q_bbbbbbb1", "q_aaaaaaa2", "q_bbbbbbb2"]);
    const withIt = await nextUpCandidates(A, {}, { db, strategy: async () => approved });
    expect(withIt.map((c) => `${c.questionId}:${c.focus}`)).toEqual(["q_aaaaaaa2:true", "q_bbbbbbb1:false", "q_bbbbbbb2:false"]);
    // It names the focus situation it is on, so a pick can say which one it serves.
    expect(withIt.map((c) => c.situationId ?? null)).toEqual(["sit_focus0001", null, null]);
    expect(without.every((c) => c.situationId === undefined)).toBe(true);
  });

  it("reads the approved strategy itself only with its switch on", async () => {
    const db = new FakeFirestore();
    await saveBrandMap(A, { baseRev: 0, decided: DECIDED }, { db, nowMs: Date.parse("2026-11-18T10:00:00.000Z") });
    db.seed("brand_map_pages", "p_a", row("p_a", { state: "live", primaryRef: "q_aaaaaaa1", url: "https://acme.example/a", liveAt: "2026-10-01T00:00:00.000Z", subjectId: "sub_aaaaaaaa" }) as never);
    const store = brandMapRecords(A, db);
    const text = "A client asks how it is measured";
    await store.create("sit", "sit_focus0001", { status: "decided", from: "person", text, textKey: situationKey(text), rev: 0, order: 0, createdAt: "", updatedAt: "" });
    // Only its words match the map's list here: a question record kept under another id.
    await store.create("q", "q_zzzzzzz2", { status: "decided", from: "person", subjectId: "sub_aaaaaaaa", text: "How is it measured?", textKey: questionKey("How is it measured?"), situationIds: ["sit_focus0001"], rev: 0, createdAt: "", updatedAt: "" });
    db.seed("brand_strategy", "bst_ten_A", { tenantId: "ten_A", rev: 1, approved: { focusSituationIds: ["sit_focus0001"], at: "2026-11-25T10:00:00.000Z" } } as never);
    // Off: the strategy is never read, and the order is as before.
    expect((await nextUpCandidates(A, {}, { db })).map((c) => c.questionId)).toEqual(["q_bbbbbbb1", "q_aaaaaaa2", "q_bbbbbbb2"]);
    vi.stubEnv("BRAND_STRATEGY_ENABLED", "true");
    expect((await nextUpCandidates(A, {}, { db })).map((c) => c.questionId)).toEqual(["q_aaaaaaa2", "q_bbbbbbb1", "q_bbbbbbb2"]);
  });
});
