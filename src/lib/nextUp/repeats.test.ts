import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import { BrandMapDecidedSchema } from "@/lib/types/brandMap";
import { BrandMapPageFactsSchema, type BrandMapPage } from "@/lib/types/brandMapPage";
import { withDerivedFacts } from "@/lib/content/blog/pageRow";
import { matchQuestion } from "@/lib/content/blog/coverage";
import { ensureMoved } from "@/lib/brandMap/move";
import { parseQuestion } from "@/lib/brandMap/records";
import { subjectCoverage } from "@/lib/brandMap/recount";
import { saveBrandMap } from "@/lib/brandMap/store";
import { addLearned, listLearned } from "@/lib/autopilot/learned";
import type { Candidate } from "./candidates";
import { subjectNeed } from "./candidates";
import { CLOSE_SIM, findRepeats, linkAnswered, NO_REPEATS, pageTexts, SAME_SIM, unlinkQuestion } from "./repeats";

/** Stop repeats: questions matched by meaning against the brand's articles before Next up offers them. */

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "admin" };
const NOW = new Date("2026-11-25T12:00:00.000Z");

const Q = {
  same: { id: "q_bbbbbbbb", text: "What is share of voice and how does it work?" },
  close: { id: "q_cccccccc", text: "Which tools track share of voice in AI answers?" },
  writing: { id: "q_dddddddd", text: "What does share of voice tracking cost?" },
  open: { id: "q_eeeeeeee", text: "Why do AI answers cite some pages?" },
};

const DECIDED = BrandMapDecidedSchema.parse({
  identity: { name: "Acme", site: "https://acme.example" },
  subjects: [
    {
      id: "sub_aaaaaaaa",
      name: "Share of voice",
      questions: [{ id: "q_aaaaaaaa", text: "What is share of voice?", intent: "definition" }, ...Object.values(Q).map((q) => ({ ...q, intent: "other" }))],
    },
  ],
});

let n = 0;
function row(id: string, over: Record<string, unknown>): BrandMapPage {
  const facts = withDerivedFacts(BrandMapPageFactsSchema.parse({ kind: "article", workspaceId: "ws1", planId: id, title: id, state: "draft", ...over }));
  n += 1;
  return { ...facts, id, tenantId: "ten_A", fingerprint: `f${n}`, updatedAt: "" };
}

const ROWS = [
  row("p_a", { state: "live", primaryRef: "q_aaaaaaaa", primaryQuestion: "What's share of voice?", title: "What is share of voice?", url: "https://acme.example/blog/sov", liveAt: "2026-10-19T00:00:00.000Z", subjectId: "sub_aaaaaaaa" }),
  row("p_d", { state: "live", primaryQuestion: "Share of voice, explained", title: "Share of voice, explained", url: "https://acme.example/blog/sov-explained", liveAt: "2026-11-22T00:00:00.000Z" }),
  row("p_b", { state: "draft", primaryQuestion: "How much does share of voice tracking cost?", title: "Pricing" }),
];

/** Unit vectors by topic: the same ask shares a vector; a close one leans 0.9 towards it. */
const E = (i: number) => Array.from({ length: 6 }, (_, k) => (k === i ? 1 : 0));
const lean = (a: number, b: number, c: number) => Array.from({ length: 6 }, (_, k) => (k === a ? c : k === b ? Math.sqrt(1 - c * c) : 0));
function vectorOf(text: string): number[] {
  const t = text.toLowerCase();
  if (t.includes("tools track")) return lean(0, 1, 0.9);
  if (t.includes("cost")) return E(2);
  if (t.includes("cite some pages")) return E(3);
  if (t.includes("share of voice")) return E(0);
  return E(4);
}
const embed = vi.fn(async (items: Array<{ content: string }>) => items.map((i) => vectorOf(i.content)));

const cand = (q: { id: string; text: string }): Candidate => ({ questionId: q.id, question: q.text, subjectId: "sub_aaaaaaaa", subjectName: "Share of voice", answered: 1, total: 5, lastArticleAt: null, focus: false });
const all = () => Object.values(Q).map(cand);

async function setup() {
  const db = new FakeFirestore();
  await saveBrandMap(ctx, { baseRev: 0, decided: DECIDED }, { db, nowMs: NOW.getTime() });
  await ensureMoved(ctx, { db, nowMs: NOW.getTime() });
  for (const r of ROWS) db.seed("brand_map_pages", r.id, r as never);
  return { db, deps: { db, now: () => NOW, embed: embed as never, pages: async () => ROWS } };
}

beforeEach(() => {
  for (const s of ["BRAND_MAP_ENABLED", "BRAND_MAP_PAGES_ENABLED", "BRAND_MAP_SCALE_ENABLED", "BRAND_MAP_NEXT_UP_ENABLED", "NEXT_UP_REPEATS_ENABLED"]) vi.stubEnv(s, "true");
  embed.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("findRepeats", () => {
  it("links what a live article answers, leaves out what one being written covers, and marks what is close", async () => {
    const { deps } = await setup();
    const r = await findRepeats(ctx, { questions: all(), moved: true }, deps);
    expect(r.byMeaning).toBe(true);
    expect(r.linked).toEqual([{ questionId: Q.same.id, subjectId: "sub_aaaaaaaa", pageId: "p_a", sim: 1 }]);
    expect(r.inProgress).toEqual([Q.writing.id]);
    expect(r.close.get(Q.close.id)).toMatchObject({ planId: "p_a", title: "What is share of voice?", url: "https://acme.example/blog/sov", sim: 0.9 });
    expect(r.close.has(Q.open.id)).toBe(false);
    // One embedding call for the questions and every article's texts together.
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it("says when two live articles answer one question, the older first", async () => {
    const { deps } = await setup();
    const r = await findRepeats(ctx, { questions: all(), moved: true }, deps);
    expect(r.repeatsLive).toHaveLength(1);
    expect(r.repeatsLive[0]!.pages.map((p) => p.url)).toEqual(["https://acme.example/blog/sov", "https://acme.example/blog/sov-explained"]);
  });

  it("with no embedding, counts close wording as close and never links", async () => {
    const { deps } = await setup();
    const r = await findRepeats(ctx, { questions: all(), moved: true }, { ...deps, embed: (async (items: unknown[]) => items.map(() => null)) as never });
    expect(r.byMeaning).toBe(false);
    expect(r.linked).toEqual([]);
    expect(r.repeatsLive).toEqual([]);
    expect(r.close.get(Q.same.id)).toMatchObject({ planId: "p_a", sim: CLOSE_SIM });
  });

  it("leaves a question a person wrote anyway unmarked for 90 days", async () => {
    const { db, deps } = await setup();
    await addLearned(ctx, { kind: "wrote_anyway", text: Q.close.text, questionId: Q.close.id, from: "person" }, { db, now: () => NOW });
    const r = await findRepeats(ctx, { questions: all(), moved: true }, deps);
    expect(r.close.has(Q.close.id)).toBe(false);
  });

  it("does nothing with the switch off", async () => {
    vi.stubEnv("NEXT_UP_REPEATS_ENABLED", "false");
    const { deps } = await setup();
    expect(await findRepeats(ctx, { questions: all(), moved: true }, deps)).toBe(NO_REPEATS);
    expect(embed).not.toHaveBeenCalled();
  });

  it("keeps the cut offs where scripts/measure-repeat-match.ts measured them", () => {
    expect(SAME_SIM).toBe(0.95);
    expect(CLOSE_SIM).toBeLessThan(SAME_SIM);
    expect(pageTexts({ primaryQuestion: "A?", title: "a?", questions: [{ text: "B?", ref: null }] })).toEqual(["A?", "B?"]);
  });
});

describe("linking and Unlink", () => {
  it("keeps the link on the question, so its subject counts it answered; Unlink takes it back for good", async () => {
    const { db, deps } = await setup();
    const r = await findRepeats(ctx, { questions: all(), moved: true }, deps);
    expect(await linkAnswered(ctx, r.linked, { db, now: () => NOW })).toBe(1);
    // A second pick finds the link already there.
    expect(await linkAnswered(ctx, r.linked, { db, now: () => NOW })).toBe(0);
    const linked = parseQuestion(await brandMapRecords(ctx, db).get("q", Q.same.id));
    expect(linked?.answeredBy).toMatchObject({ pageId: "p_a", sim: 1 });
    let cov = await subjectCoverage(ctx, "sub_aaaaaaaa", { db });
    expect(cov!.coverage.questions.find((q) => q.id === Q.same.id)!.state).toBe("answered");

    expect(await unlinkQuestion(ctx, Q.same.id, { db, now: () => NOW })).toBe(true);
    expect(await unlinkQuestion(ctx, Q.same.id, { db, now: () => NOW })).toBe(false);
    const after = parseQuestion(await brandMapRecords(ctx, db).get("q", Q.same.id));
    expect(after).toMatchObject({ answeredBy: null, notAnsweredBy: ["p_a"] });
    cov = await subjectCoverage(ctx, "sub_aaaaaaaa", { db });
    expect(cov!.coverage.questions.find((q) => q.id === Q.same.id)!.state).toBe("open");
    expect((await listLearned(ctx, { db })).map((e) => e.kind)).toContain("unlinked");
    // Never matched to that article again.
    const again = await findRepeats(ctx, { questions: all(), moved: true }, deps);
    expect(again.linked.every((l) => l.pageId !== "p_a")).toBe(true);
    expect(again.close.get(Q.same.id)?.planId).not.toBe("p_a");
    // The other live article on it still answers it.
    expect(again.linked.find((l) => l.questionId === Q.same.id)?.pageId).toBe("p_d");
  });

  it("never touches another brand's question", async () => {
    const { db } = await setup();
    const other: TenantContext = { ...ctx, tenantId: "ten_B" };
    expect(await linkAnswered(other, [{ questionId: Q.same.id, subjectId: "sub_aaaaaaaa", pageId: "p_a", sim: 1 }], { db })).toBe(0);
    expect(parseQuestion(await brandMapRecords(ctx, db).get("q", Q.same.id))?.answeredBy).toBeNull();
  });
});

describe("coverage and the order of subjects", () => {
  it("counts a page matched by meaning as sure, unless a person unlinked it", () => {
    const page = { id: "p_a", primaryRef: null, primaryQuestion: "Something else entirely", title: "", questions: [] };
    expect(matchQuestion({ id: "q_x", text: "What is it?", answeredBy: { pageId: "p_a" } }, page)).toBe("sure");
    expect(matchQuestion({ id: "q_x", text: "What is it?", answeredBy: { pageId: "p_a" }, notAnsweredBy: ["p_a"] }, page)).toBeNull();
    expect(matchQuestion({ id: "q_x", text: "What is it?" }, page)).toBeNull();
  });

  it("weighs a subject by its size, so one question at nothing answered no longer goes first", () => {
    expect(subjectNeed(0, 1)).toBe(1);
    expect(subjectNeed(0.15, 74)).toBeGreaterThan(7);
    expect(subjectNeed(0.33, 2)).toBeLessThan(1);
    expect(subjectNeed(1, 10)).toBe(0);
  });
});
