import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { BrandMapDecidedSchema } from "@/lib/types/brandMap";
import { BrandMapPageSchema, type BrandMapPage } from "@/lib/types/brandMapPage";
import { computeCoverage } from "@/lib/content/blog/coverage";
import { projectArticleMap, researchMapBlock, researchSubjectLine, writerMapBlock } from "@/lib/content/blog/articleMap";
import { SAMPLE_BRIEF } from "@/lib/content/blog/testing/sampleArticle";
import { agentContentContext } from "@/lib/content/agentApi";
import { agentBrandMap } from "./agentApi";
import { homesOf, layoutContentMap, mapPageOf } from "./contentMapLayout";
import { saveBrandMap } from "./store";

/**
 * Pins what the brand map sends and shows TODAY, with its own switches on: the blocks every
 * article's research and writer get, coverage, the content map's layout, and both of Vizzy's
 * reads (research's own prompt is pinned in pins.research.test.ts). With the scale,
 * situations and import switches off, every one must stay exactly as it is, so these digests
 * never change.
 */

const digest = (value: unknown) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex")
    .slice(0, 16);

const ctx: TenantContext = { tenantId: "ten_pin", region: "us", source: "agent", userId: "usr_admin", role: "admin" };

const DECIDED = BrandMapDecidedSchema.parse({
  identity: {
    name: "Acme",
    category: "AI visibility tracking",
    statement: "Acme shows marketing teams how AI assistants describe their brand.",
    isNot: ["an SEO rank tracker"],
    avoid: [{ term: "LLM SEO", useInstead: "AI visibility tracking" }],
    site: "https://acme.example",
  },
  subjects: [
    {
      id: "sub_aaaaaaaa",
      name: "Share of voice",
      home: "https://acme.example/share-of-voice",
      questions: [
        { id: "q_aaaaaaaa", text: "What is share of voice in AI search?", intent: "definition" },
        { id: "q_bbbbbbbb", text: "How is AI share of voice measured?", intent: "benchmarks" },
        { id: "q_cccccccc", text: "Which tools track AI share of voice?", intent: "alternatives" },
      ],
    },
    { id: "sub_bbbbbbbb", name: "Citations", questions: [{ id: "q_dddddddd", text: "Which sources do AI engines cite?", intent: "other" }] },
    { id: "sub_cccccccc", name: "Audits", questions: [] },
  ],
  names: [
    { id: "n_aaaaaaaa", name: "Rivalco", kind: "alternative" },
    { id: "n_bbbbbbbb", name: "Acme Pulse", kind: "product", aliases: ["Pulse"], home: "https://acme.example/pulse" },
  ],
});

const row = (id: string, over: Partial<BrandMapPage>): BrandMapPage =>
  BrandMapPageSchema.parse({ id, tenantId: ctx.tenantId, kind: "article", workspaceId: "ws1", planId: id, title: id, state: "draft", ...over });

const ROWS = [
  row("p_a", { state: "live", primaryRef: "q_aaaaaaaa", primaryQuestion: "What's share of voice?", url: "https://acme.example/blog/sov", liveAt: "2026-09-01T00:00:00.000Z", subjectId: "sub_aaaaaaaa", links: ["https://acme.example/pulse"] }),
  row("p_b", { primaryQuestion: "How is AI share of voice measured?", subjectId: "sub_aaaaaaaa" }),
  row("p_c", { state: "planned", primaryQuestion: "Which sources do AI engines cite?" }),
  row("p_d", { state: "live", primaryRef: "q_aaaaaaaa", url: "https://acme.example/blog/sov-2", liveAt: "2026-10-01T00:00:00.000Z", subjectId: "sub_aaaaaaaa" }),
  row("s_e", { kind: "site", workspaceId: null, planId: null, state: "live", url: "https://acme.example/share-of-voice", title: "Share of voice" }),
];

beforeEach(() => {
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_PAGES_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_CHAT_ENABLED", "true");
  vi.stubEnv("CREATE_BLOG_BRAND_MAP_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("what the brand map sends and shows today", () => {
  it("gives every article's research and writer the same blocks", () => {
    const map = projectArticleMap({ rev: 1, ...DECIDED });
    map.answered = { q_aaaaaaaa: { title: "p_d", url: "https://acme.example/blog/sov-2", state: "live" } };
    map.siblings = [{ subjectId: "sub_aaaaaaaa", title: "p_d", url: "https://acme.example/blog/sov-2" }];
    const open = { ...SAMPLE_BRIEF, subjectId: undefined };
    const chosen = { ...SAMPLE_BRIEF, subjectId: "sub_aaaaaaaa" };
    expect(digest(researchMapBlock(map, open))).toBe("efcb3757ed8a69ae");
    expect(digest(researchSubjectLine(map, open))).toBe("e2639f936d08de27");
    expect(digest(researchMapBlock(map, chosen))).toBe("281be331ea3283c3");
    expect(digest(writerMapBlock(map, chosen))).toBe("278ba616ecee2d0b");
  });

  it("works out the same coverage and draws the same content map", () => {
    const coverage = computeCoverage(DECIDED, ROWS);
    expect(digest(coverage)).toBe("aa9e060e2a7fb624");
    const layout = layoutContentMap({ brand: { name: "Acme", statement: DECIDED.identity.statement }, coverage, pages: ROWS.map(mapPageOf), homes: homesOf(DECIDED) });
    expect(digest(layout)).toBe("0673cb4c6439fe34");
  });

  it("gives Vizzy the same two reads", async () => {
    const db = new FakeFirestore();
    await saveBrandMap(ctx, { baseRev: 0, decided: DECIDED }, { db });
    for (const r of ROWS) db.seed("brand_map_pages", r.id, r as never);
    const map = await agentBrandMap(ctx, db);
    expect(digest(map.body)).toBe("5eae4751f1bb1e7c");
    const content = await agentContentContext(ctx, {}, db);
    expect(digest((content.body as { brandMap?: unknown }).brandMap)).toBe("7c898524d2f1e1ca");
  });
});
