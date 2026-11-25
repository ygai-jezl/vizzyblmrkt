import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { NO_USAGE } from "@/lib/agents/gemini";
import { BlogArticleMetaSchema, BlogBriefSchema, type ContentPlan } from "@/lib/types/contentPlan";
import type { ArticleReviewDoc, RefreshRecord } from "@/lib/types/articleRefresh";
import { advanceReview, readReview, REVIEW_NOTES, runRefreshReviews, startReview, stopReview, type ReviewDeps } from "./refreshReview";
import { reviewHolds } from "./refreshHold";
import { applyReview, checkProposal, dismissReview, fingerprintOf, insertSection } from "./refreshPropose";
import { listVersions } from "./versions";
import { reviewsThisMonth } from "./refreshRecords";
import { sampleHub, samplePlan } from "./testing/samplePlan";

/** A refresh review, step by step, then Apply: everything outside is a stub; the data is a FakeFirestore. */

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u1", role: "member" };
const OTHER: TenantContext = { ...ctx, tenantId: "ten_B" };
const PLANS = "workspaces/ws1/content_plans";
const NOW = new Date("2026-11-25T10:00:00.000Z");

const OLD_LINE = "In 2024, 38% of software buyers asked an AI assistant first [Old Survey, 2024](https://old.example.org/survey).";
const BODY = [
  "# What is AI search visibility monitoring?",
  "",
  OLD_LINE,
  "",
  "## How does it work?",
  "",
  "It works by asking engines the questions buyers ask. See [the guide](https://gone.example.com/guide).",
  "",
  // Enough copy that a 40-word section fits the growth cap (a quarter of the article).
  Array.from({ length: 220 }, (_, i) => `detail${i % 11}`).join(" ") + ".",
  "",
  "## Sources",
  "",
  "- [Old Survey, 2024](https://old.example.org/survey)",
].join("\n");

const live = { url: "https://acme.example/blog/visibility", at: "2026-10-03T09:00:00.000Z", by: "check" as const, titleMatched: true, checkedAt: "2026-10-03T09:00:00.000Z" };
const dates = { published: { at: "2026-10-03", source: "page" as const } };
const freshness = {
  clockDays: 30 as const,
  arm: "test" as const,
  assignedAt: "2026-10-04T00:00:00.000Z",
  checkedAt: null,
  state: "due" as const,
  reasons: [{ kind: "age" as const, detail: "53 days since its last update or check, on a 30-day clock", hard: true }],
  dueAt: "2026-11-02T00:00:00.000Z",
  sweptAt: "2026-11-25T00:00:00.000Z",
  deadLinks: [],
  linksCheckedAt: null,
  openAtStart: null,
  events: [],
};

function seed(db: FakeFirestore): ContentPlan {
  const plan = samplePlan(
    {
      blog: BlogBriefSchema.parse({
        primaryQuestion: "What is AI search visibility monitoring?",
        publisherName: "Acme",
        sources: [{ url: "https://old.example.org/survey", title: "Old Survey", publisher: "Old Survey", year: 2024, fact: "In 2024, 38% of software buyers asked an AI assistant first.", status: "verified" }],
      }),
    },
    sampleHub({ status: "approved", body: BODY, blog: { ...BlogArticleMetaSchema.parse({ metaTitle: "Visibility" }), live, dates, freshness } }),
  );
  db.seed(PLANS, plan.id, plan);
  db.seed("workspaces", "ws1", { id: "ws1", tenantId: "ten_A", name: "Acme", audience: "B2B marketers" });
  return plan;
}

const NEW_FACT = "In 2026, 52% of software buyers asked an AI assistant before a vendor call.";
const SECTION = `## Can I see which prompts cite my competitors?\n\n${Array.from({ length: 40 }, (_, i) => `word${i % 9}`).join(" ")}.`;

const changes = (extra: object[] = []) =>
  JSON.stringify({
    changes: [
      { kind: "newer_figure", old: OLD_LINE, new: `${NEW_FACT.replace(/\.$/, "")} [New Survey, 2026](https://new.example.org/2026).`, after: null, evidence: ["e3"], why: "Newer survey" },
      // A figure no evidence gives: dropped.
      { kind: "newer_figure", old: OLD_LINE, new: "In 2026, 70% of buyers asked first.", after: null, evidence: ["e3"], why: "x" },
      { kind: "answer_search", old: null, new: SECTION, after: "How does it work?", evidence: ["e5"], why: "A search that lands here" },
      // A dash used as punctuation: dropped.
      { kind: "answer_search", old: null, new: `## Is it worth it?\n\nYes — ${Array.from({ length: 40 }, () => "word").join(" ")}.`, after: null, evidence: ["e4"], why: "x" },
      ...extra,
    ],
  });

function deps(db: FakeFirestore, over: Partial<ReviewDeps> = {}): ReviewDeps {
  return {
    db,
    now: () => NOW,
    usage: NO_USAGE,
    brand: async () => ({ name: "Acme", sites: ["acme.example"] }),
    checkLink: async (url) => (url.includes("gone.example.com") ? "dead" : "ok"),
    fetchPage: async (url) => ({ url, title: "Old Survey", siteName: "", year: 2024, text: "A page that no longer shows the figure." }),
    research: async (input) => ({
      brief: BlogBriefSchema.parse({
        ...input.plan.blog,
        sources: [{ url: "https://new.example.org/2026", title: "New Survey", publisher: "New Survey", year: 2026, fact: NEW_FACT, status: "verified" }],
        questions: [{ question: "Is it worth it for a small team?", intent: "other", by: "research" }],
      }),
      searched: true,
      found: { questions: 1, links: 0, facts: 1, sources: 1, verifiedSources: 1 },
    }) as never,
    openQuestions: async () => [],
    retrieve: async () => null,
    pageSearches: async () => ({ rows: [{ query: "can i see which prompts cite my competitors", impressions: 410, clicks: 3, position: 8.2 }], note: null }),
    generate: async () => changes(),
    ...over,
  };
}

async function runAll(d: ReviewDeps): Promise<ArticleReviewDoc | null> {
  let r: ArticleReviewDoc | null = null;
  for (let i = 0; i < 6; i++) r = (await advanceReview(ctx, "plan_1", { deadlineMs: Date.now() + 60_000 }, d)) ?? r;
  return r;
}

const stored = (db: FakeFirestore) => (db.raw(PLANS, "plan_1") as ContentPlan).graph.nodes[0]!;

beforeEach(() => {
  for (const s of ["BRAND_MAP_ENABLED", "BRAND_MAP_PAGES_ENABLED", "BLOG_DATES_ENABLED", "BLOG_FRESHNESS_ENABLED", "BLOG_REFRESH_ENABLED", "CREATE_BLOG_CITABLE_ENABLED"]) vi.stubEnv(s, "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("starting a review", () => {
  it("is off with the switch off, and only for a live article with copy", async () => {
    const db = new FakeFirestore();
    const plan = seed(db);
    vi.stubEnv("BLOG_REFRESH_ENABLED", "false");
    expect(await startReview(ctx, { plan, by: "person" }, deps(db))).toMatchObject({ ok: false, status: 503 });
    vi.stubEnv("BLOG_REFRESH_ENABLED", "true");
    const notLive = samplePlan({}, sampleHub({ body: BODY }));
    expect(await startReview(ctx, { plan: notLive, by: "person" }, deps(db))).toMatchObject({ ok: false, status: 409, error: "not_live" });
  });

  it("starts one review at a time, with why it ran, a record, and holds Regenerate meanwhile", async () => {
    const db = new FakeFirestore();
    const plan = seed(db);
    const first = await startReview(ctx, { plan, by: "person" }, deps(db));
    expect(first.ok && first.started).toBe(true);
    expect(first.ok && first.review).toMatchObject({ step: "read", state: "running", by: "person", byUid: "u1", month: "2026-11", why: { state: "due", clockDays: 30, waitedDays: 23 } });
    const again = await startReview(ctx, { plan, by: "autopilot" }, deps(db));
    expect(again.ok && again.started).toBe(false);
    expect(await reviewsThisMonth(ctx, { db, now: () => NOW })).toBe(1);
    expect(await reviewHolds(ctx, "plan_1", { db })).toBe(true);
    // Another brand sees none of it.
    expect(await readReview(OTHER, "plan_1", { db })).toBeNull();
    expect(await reviewHolds(OTHER, "plan_1", { db })).toBe(false);
    await stopReview(ctx, "plan_1", { db, now: () => NOW });
    expect(await reviewHolds(ctx, "plan_1", { db })).toBe(false);
    expect((db.raw("refresh_records", `rr_${first.ok ? first.review.reviewId : ""}`) as unknown as RefreshRecord).decision).toMatchObject({ outcome: "stopped" });
  });
});

describe("the review's steps", () => {
  it("reads, opens its sources, researches, reads the brand and proposes checked changes", async () => {
    const db = new FakeFirestore();
    const plan = seed(db);
    await startReview(ctx, { plan, by: "person" }, deps(db));
    const r = await runAll(deps(db));
    expect(r).toMatchObject({ state: "ready", active: false, step: null });
    expect(r!.reading).toMatchObject({ headings: ["How does it work?"], links: ["https://old.example.org/survey", "https://gone.example.com/guide"] });
    expect(r!.evidence.map((e) => [e.id, e.kind])).toEqual([
      ["e1", "dead_link"],
      ["e2", "source_changed"],
      ["e3", "new_fact"],
      ["e4", "new_question"],
      ["e5", "page_search"],
    ]);
    expect(r!.evidence[4]!.detail).toBe("410 impressions, 3 clicks, position 8.2 in 28 days, and the page doesn't answer it");
    // Code's link change first, then the model's that passed: the invented figure and the dash are gone.
    expect(r!.proposals.map((p) => [p.id, p.kind, p.real, p.ticked])).toEqual([
      ["p1", "dead_source", false, true],
      ["p2", "newer_figure", true, true],
      ["p3", "answer_search", true, true],
    ]);
    expect(r!.proposals[0]).toMatchObject({ old: "[the guide](https://gone.example.com/guide)", new: "the guide" });
    expect(r!.proposals[1]!.source).toMatchObject({ url: "https://new.example.org/2026", year: 2026, fact: NEW_FACT });
    const record = db.raw("refresh_records", `rr_${r!.reviewId}`) as unknown as RefreshRecord;
    expect(record.proposal).toMatchObject({ count: 3, kinds: { dead_source: 1, newer_figure: 1, answer_search: 1 } });
    expect(record.observation.liveUrl).toBe(live.url);
  });

  it("says what it couldn't read, and tries a failed step again before giving up", async () => {
    const db = new FakeFirestore();
    const plan = seed(db);
    await startReview(ctx, { plan, by: "person" }, deps(db));
    const d = deps(db, { pageSearches: async () => ({ rows: [], note: REVIEW_NOTES.noSearchConsole }), generate: async () => null });
    let now = NOW.getTime();
    d.now = () => new Date(now);
    let r: ArticleReviewDoc | null = null;
    for (let i = 0; i < 10; i++) {
      r = (await advanceReview(ctx, "plan_1", { deadlineMs: Date.now() + 60_000 }, d)) ?? r;
      now += 3 * 60_000;
    }
    expect(r).toMatchObject({ state: "failed", error: "propose_failed", notes: [REVIEW_NOTES.noSearchConsole] });
  });

  it("finds nothing worth changing: the clock starts again and Updated stays", async () => {
    const db = new FakeFirestore();
    const plan = seed(db);
    await startReview(ctx, { plan, by: "person" }, deps(db));
    const r = await runAll(deps(db, { checkLink: async () => "ok", generate: async () => JSON.stringify({ changes: [] }) }));
    expect(r).toMatchObject({ state: "nothing", proposals: [] });
    const node = stored(db);
    expect(node.blog?.freshness?.events.map((e) => e.kind)).toEqual(["checked"]);
    expect(node.blog?.dates?.updated).toBeUndefined();
    expect((db.raw("refresh_records", `rr_${r!.reviewId}`) as unknown as RefreshRecord).decision).toMatchObject({ outcome: "nothing", accepted: 0 });
  });

  it("moves running reviews on from the tick, a few a tick", async () => {
    const db = new FakeFirestore();
    const plan = seed(db);
    await startReview(ctx, { plan, by: "autopilot" }, deps(db));
    const d = deps(db, { listTenants: async () => [{ id: "ten_A", region: "us", status: "active" }] as never });
    expect(await runRefreshReviews({ deadlineMs: Date.now() + 90_000 }, d)).toEqual({ brands: 1, advanced: 1 });
    expect((await readReview(ctx, "plan_1", d))!.step).toBe("sources");
  });
});

describe("checking a proposed change", () => {
  const ev = new Map([
    ["e1", { id: "e1", kind: "new_fact" as const, text: NEW_FACT, url: "https://new.example.org/2026", year: 2026, detail: "New Survey" }],
    ["e2", { id: "e2", kind: "page_search" as const, text: "track competitor citations", url: null, year: null, detail: "" }],
  ]);
  const ok = { kind: "newer_figure", old: OLD_LINE, new: `${NEW_FACT} [New Survey, 2026](https://new.example.org/2026)`, after: null, evidence: ["e1"], why: "" };

  it("keeps a change whose text, figures and links hold", () => {
    expect(checkProposal(BODY, ok, ev, new Set(), "p1")).toMatchObject({ real: true, ticked: true });
  });

  it("drops one that doesn't", () => {
    const no = (over: object) => checkProposal(BODY, { ...ok, ...over }, ev, new Set(), "p1");
    expect(no({ old: "Not in the article." })).toBeNull();
    expect(no({ old: "# What is AI search visibility monitoring?" })).toBeNull();
    expect(no({ new: "In 2026, 99% asked first." })).toBeNull();
    expect(no({ new: `${NEW_FACT} [Elsewhere](https://elsewhere.example.com)` })).toBeNull();
    expect(no({ kind: "rewrite_everything" })).toBeNull();
    expect(no({ evidence: ["e9"] })).toBeNull();
    expect(no({ evidence: ["e2"] })).toBeNull();
    expect(no({ new: `${NEW_FACT} It's a game-changer.` })).toBeNull();
    // A new section needs its own heading, a short answer, and a heading of the article to follow.
    const section = { kind: "answer_search", old: null, evidence: ["e2"], after: "How does it work?" };
    expect(no({ ...section, new: "No heading here." })).toBeNull();
    expect(no({ ...section, new: "## Too short\n\nJust a few words." })).toBeNull();
    expect(no({ ...section, new: SECTION, after: "No such heading" })).toBeNull();
    expect(no({ ...section, new: SECTION })).toMatchObject({ kind: "answer_search", after: "How does it work?" });
    // One a person dismissed before.
    expect(checkProposal(BODY, ok, ev, new Set([fingerprintOf("newer_figure", [ev.get("e1")!])]), "p1")).toBeNull();
  });

  it("puts a new section after the heading it names, else before the closing sections", () => {
    expect(insertSection(BODY, SECTION, "How does it work?")).toMatch(/detail\d+\.\n\n## Can I see which prompts[\s\S]*\n\n## Sources/);
    expect(insertSection(BODY, SECTION, null)).toMatch(/## Can I see which prompts[\s\S]*\n\n## Sources/);
  });
});

describe("Apply", () => {
  async function ready(db: FakeFirestore) {
    const plan = seed(db);
    await startReview(ctx, { plan, by: "person" }, deps(db));
    return runAll(deps(db));
  }
  const factCheck = vi.fn(async () => ({ ok: true, node: { id: "hub" }, corrected: 0 }) as never);

  it("makes the ticked changes in code, keeps a version, moves Updated and sends the article back for approval", async () => {
    const db = new FakeFirestore();
    const r = await ready(db);
    const out = await applyReview(ctx, { workspace: { id: "ws1", name: "Acme" }, planId: "plan_1", ids: ["p1", "p2"] }, { db, now: () => NOW, factCheck });
    expect(out).toMatchObject({ ok: true, applied: 2, skipped: 0, real: true, checked: true });
    const node = stored(db);
    expect(node.status).toBe("generated");
    expect(node.body).toContain("See the guide.");
    expect(node.body).toContain(`${NEW_FACT.replace(/\.$/, "")} [New Survey, 2026](https://new.example.org/2026).`);
    expect(node.body).not.toContain("Can I see which prompts");
    expect(node.blog?.dates).toEqual({ ...dates, updated: { at: NOW.toISOString(), source: "change" } });
    expect(node.blog?.freshness).toMatchObject({ state: "fresh", events: [{ kind: "updated", clockDays: 30 }] });
    expect(node.blog?.live).toEqual(live);
    // The copy it replaced is a version; the new source is on the brief, so the fact check keeps its link.
    expect((await listVersions(ctx, "plan_1", { db })).map((v) => v.reason)).toEqual(["apply"]);
    expect((db.raw(PLANS, "plan_1") as ContentPlan).blog?.sources.map((s) => s.url)).toEqual(["https://new.example.org/2026", "https://old.example.org/survey"]);
    expect(factCheck).toHaveBeenCalledTimes(1);
    // The one left is dismissed for good, and the record says what was decided.
    const after = await readReview(ctx, "plan_1", { db });
    expect(after).toMatchObject({ state: "applied" });
    expect(after!.dismissed).toEqual([r!.proposals[2]!.fingerprint]);
    expect((db.raw("refresh_records", `rr_${r!.reviewId}`) as unknown as RefreshRecord).decision).toMatchObject({ outcome: "applied", accepted: 2, real: true, byUid: "u1" });
    // Applying twice does nothing.
    expect(await applyReview(ctx, { workspace: { id: "ws1", name: "Acme" }, planId: "plan_1", ids: ["p1"] }, { db, now: () => NOW, factCheck })).toMatchObject({ ok: false, error: "not_ready" });
  });

  it("counts link fixes alone as a check: Updated stays", async () => {
    const db = new FakeFirestore();
    await ready(db);
    const out = await applyReview(ctx, { workspace: { id: "ws1", name: "Acme" }, planId: "plan_1", ids: ["p1"] }, { db, now: () => NOW, factCheck });
    expect(out).toMatchObject({ ok: true, real: false });
    expect(stored(db).blog?.dates?.updated).toBeUndefined();
    expect(stored(db).blog?.freshness?.events.map((e) => e.kind)).toEqual(["checked"]);
  });

  it("skips a change whose text the team has edited since, and refuses another brand", async () => {
    const db = new FakeFirestore();
    await ready(db);
    const plan = db.raw(PLANS, "plan_1") as ContentPlan;
    plan.graph.nodes[0]!.body = BODY.replace(OLD_LINE, "Edited by hand.");
    db.seed(PLANS, "plan_1", plan);
    expect(await applyReview(OTHER, { workspace: { id: "ws1", name: "Acme" }, planId: "plan_1", ids: ["p1"] }, { db, now: () => NOW, factCheck })).toMatchObject({ ok: false, status: 404 });
    const out = await applyReview(ctx, { workspace: { id: "ws1", name: "Acme" }, planId: "plan_1", ids: ["p1", "p2"] }, { db, now: () => NOW, factCheck });
    expect(out).toMatchObject({ ok: true, applied: 1, skipped: 1 });
  });

  it("Dismiss the rest: none comes back, and it counts as a check", async () => {
    const db = new FakeFirestore();
    const r = await ready(db);
    expect(await dismissReview(ctx, { workspaceId: "ws1", planId: "plan_1" }, { db, now: () => NOW })).toMatchObject({ ok: true, review: { state: "dismissed" } });
    expect(stored(db).blog?.freshness?.events.map((e) => e.kind)).toEqual(["checked"]);
    // The next review proposes none of them again.
    const plan = db.raw(PLANS, "plan_1") as ContentPlan;
    await startReview(ctx, { plan, by: "person" }, deps(db));
    const next = await runAll(deps(db));
    expect(next!.reviewId).not.toBe(r!.reviewId);
    expect(next).toMatchObject({ state: "nothing", proposals: [] });
  });
});
