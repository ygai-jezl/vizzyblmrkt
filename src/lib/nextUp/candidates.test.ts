import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { BrandMapDecidedSchema } from "@/lib/types/brandMap";
import { BrandMapPageFactsSchema, type BrandMapPage } from "@/lib/types/brandMapPage";
import { withDerivedFacts } from "@/lib/content/blog/pageRow";
import { saveBrandMap } from "@/lib/brandMap/store";
import { nextUpCandidates } from "./candidates";

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
});
