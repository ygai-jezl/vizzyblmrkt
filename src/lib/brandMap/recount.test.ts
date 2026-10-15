import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import { BrandMapDecidedSchema, brandMapDocId } from "@/lib/types/brandMap";
import { BrandMapPageFactsSchema, type BrandMapPage } from "@/lib/types/brandMapPage";
import { computeCoverage } from "@/lib/content/blog/coverage";
import { withDerivedFacts } from "@/lib/content/blog/pageRow";
import { writePageRow } from "@/lib/content/blog/pageActions";
import { ensureMoved } from "./move";
import { recountGroup, recountSubject, subjectCoverage } from "./recount";
import { createGroup, editSubject } from "./records";
import { saveBrandMap } from "./store";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "admin" };
const NOW = Date.parse("2026-10-15T10:00:00.000Z");

const DECIDED = BrandMapDecidedSchema.parse({
  identity: { name: "Acme", site: "https://acme.example" },
  subjects: [
    {
      id: "sub_aaaaaaaa",
      name: "Share of voice",
      home: "https://acme.example/share-of-voice",
      questions: [
        { id: "q_aaaaaaaa", text: "What is share of voice?", intent: "definition" },
        { id: "q_bbbbbbbb", text: "How is share of voice measured?", intent: "benchmarks" },
        { id: "q_cccccccc", text: "Which tools track share of voice in AI answers?", intent: "alternatives" },
        { id: "q_dddddddd", text: "What does it cost?", intent: "pricing" },
      ],
    },
    { id: "sub_bbbbbbbb", name: "Citations", questions: [{ id: "q_eeeeeeee", text: "Why do AI answers cite some pages?", intent: "other" }] },
  ],
});

let n = 0;
/** A row as the map at any size stores it: with its worked-out facts. */
function row(id: string, over: Record<string, unknown>): BrandMapPage {
  const facts = withDerivedFacts(BrandMapPageFactsSchema.parse({ kind: "article", workspaceId: "ws1", planId: id, title: id, state: "draft", ...over }));
  n += 1;
  return { ...facts, id, tenantId: "ten_A", fingerprint: `f${n}`, updatedAt: "" };
}

beforeEach(() => {
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_PAGES_ENABLED", "true");
  vi.stubEnv("BRAND_MAP_SCALE_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

async function setup(rows: BrandMapPage[]) {
  const db = new FakeFirestore();
  await saveBrandMap(ctx, { baseRev: 0, decided: DECIDED }, { db, nowMs: NOW });
  await ensureMoved(ctx, { db, nowMs: NOW });
  for (const r of rows) db.seed("brand_map_pages", r.id, r as never);
  return db;
}

function rows(): BrandMapPage[] {
  return [
    row("p_a", { state: "live", primaryRef: "q_aaaaaaaa", primaryQuestion: "What's share of voice?", url: "https://acme.example/blog/sov", liveAt: "2026-09-01T00:00:00.000Z", subjectId: "sub_aaaaaaaa" }),
    row("p_b", { primaryQuestion: "How is share of voice measured?" }),
    row("p_c", { state: "planned", primaryQuestion: "What tools track AI share of voice?" }),
    row("p_d", { state: "live", primaryRef: "q_aaaaaaaa", url: "https://acme.example/blog/sov-2", liveAt: "2026-10-01T00:00:00.000Z", links: ["https://acme.example/blog/sov"], subjectId: "sub_aaaaaaaa" }),
    row("s_e", { kind: "site", workspaceId: null, planId: null, state: "live", url: "https://acme.example/share-of-voice", title: "Share of voice" }),
    row("p_f", { state: "approved", primaryQuestion: "Why do AI answers cite some pages?" }),
    // Pages about nothing on the map are never read for it.
    ...Array.from({ length: 30 }, (_, i) => row(`p_other${i}`, { primaryQuestion: `Unrelated topic number ${i} entirely`, state: "live" })),
  ];
}

describe("coverage one subject at a time", () => {
  it("is the same as today's coverage of the whole map, from the subject's own rows", async () => {
    const all = rows();
    const db = await setup(all);
    const today = computeCoverage(DECIDED, all);
    for (const [i, s] of DECIDED.subjects.entries()) {
      const read = await subjectCoverage(ctx, s.id, { db });
      expect(read?.coverage).toEqual(today.subjects[i]);
    }
    const sov = await subjectCoverage(ctx, "sub_aaaaaaaa", { db });
    expect(sov?.missingLinks).toEqual(today.missingLinks.filter((m) => m.subjectId === "sub_aaaaaaaa"));
  });

  it("stores a subject's counts and its group's totals, and the ungrouped ones' on the brand's record", async () => {
    const db = await setup(rows());
    await recountSubject(ctx, "sub_aaaaaaaa", { db });
    const store = brandMapRecords(ctx, db);
    expect(await store.get("sub", "sub_aaaaaaaa")).toMatchObject({
      counts: { questions: 4, answered: 1, drafted: 1, planned: 0, open: 2 },
      answeredShare: 250,
      answeredIds: ["q_aaaaaaaa"],
      draftedIds: ["q_bbbbbbbb"],
    });
    expect(await recountGroup(ctx, null, { db })).toMatchObject({ subjects: 2, questions: 5, answered: 1, subjectsAnswered: 1, subjectsOpen: 1 });
    expect(db.raw("brand_maps", brandMapDocId("ten_A"))?.ungroupedTotals).toMatchObject({ subjects: 2, answered: 1 });

    const g = await createGroup(ctx, { name: "Tracking" }, { db });
    const gid = g.ok ? g.value.id : "";
    const sub = await store.get("sub", "sub_aaaaaaaa");
    await editSubject(ctx, "sub_aaaaaaaa", { baseRev: Number(sub?.rev ?? 0), groupId: gid }, { db });
    expect(await recountGroup(ctx, gid, { db })).toMatchObject({ subjects: 1, questions: 4, answered: 1 });
  });

  it("recounts what a page row points at when it is written", async () => {
    const db = await setup([]);
    await recountSubject(ctx, "sub_bbbbbbbb", { db });
    expect((await brandMapRecords(ctx, db).get("sub", "sub_bbbbbbbb"))?.counts).toMatchObject({ questions: 1, answered: 0 });
    const facts = withDerivedFacts(BrandMapPageFactsSchema.parse({ kind: "article", workspaceId: "ws1", planId: "x", title: "Why AI cites pages", state: "live", url: "https://acme.example/blog/cite", liveAt: "2026-10-01T00:00:00.000Z", primaryRef: "q_eeeeeeee" }));
    await writePageRow(ctx, "p_x", facts, { db });
    expect((await brandMapRecords(ctx, db).get("sub", "sub_bbbbbbbb"))?.counts).toMatchObject({ questions: 1, answered: 1 });
  });
});
