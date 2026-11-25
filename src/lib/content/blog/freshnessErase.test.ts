import { afterEach, describe, expect, it, vi } from "vitest";
import { forTenant } from "@/lib/tenant";
import { failingFirestore } from "@/lib/tenant/testing/failingFirestore";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { getContentPlan } from "@/lib/tenant/workspaceContent";
import { nextUpDocId } from "@/lib/types/autopilot";
import { BlogArticleMetaSchema, type ContentPlan } from "@/lib/types/contentPlan";
import { clearSearchConsoleArticles, clearSearchConsoleReasons, FRESHNESS_CLEAR } from "./freshnessErase";
import { freshnessWatchId, LIVE_ARTICLES, liveArticles } from "./freshnessPages";
import { FRESH, FRESH_REASONS, seedFreshArticle } from "./testing/freshness";
import { sampleHub, samplePlan } from "./testing/samplePlan";

// Search Console's numbers taken out of article freshness, as an erase does: Harbour Blooms' live
// article, its due list and its Next up. Every switch is off: the clear never depends on one.
const H: TenantContext = { tenantId: "ten_harbour", region: "us", source: "system" };
const NOW = new Date("2026-11-25T09:00:00.000Z");
const LATER = new Date("2026-11-25T09:05:00.000Z");

const kinds = (reasons: readonly { kind: string }[]) => reasons.map((r) => r.kind);
const watch = async (db: FakeFirestore) => (await forTenant(H, db).freshnessWatch.getById(freshnessWatchId(H.tenantId)))!;
const card = async (db: FakeFirestore) => (await getContentPlan(H, FRESH.workspaceId, FRESH.planId, db))!.graph.nodes[0]!;
const nextUp = async (db: FakeFirestore) => (await forTenant(H, db).nextUp.getById(nextUpDocId(H.tenantId)))!;

afterEach(() => vi.restoreAllMocks());

describe("clearing Search Console's figures from article freshness", () => {
  it("takes them off the due list, the article and Next up, keeps everything else, and makes the watch due now", async () => {
    const db = new FakeFirestore();
    await seedFreshArticle(H, db, NOW);
    const before = { watch: await watch(db), node: await card(db) };
    expect(await clearSearchConsoleReasons(H, { db, now: LATER })).toEqual({ due: 1, articles: 1, picks: 1, failed: false, finished: true });

    const w = await watch(db);
    expect(kinds(w.due[0]!.reasons)).toEqual(["dead_link"]);
    // Its count of erases moves on, so a look already running writes none of them back.
    expect(w).toEqual({ ...before.watch, nextAt: LATER.toISOString(), due: [{ ...before.watch.due[0]!, reasons: [FRESH_REASONS[1]] }], searchConsoleClears: 1 });

    // Nothing else on the article changes: its body, status, live mark, dates and the rest of its freshness.
    const node = await card(db);
    expect(kinds(node.blog!.freshness!.reasons)).toEqual(["dead_link"]);
    expect(node).toEqual({ ...before.node, blog: { ...before.node.blog!, freshness: { ...before.node.blog!.freshness!, reasons: [FRESH_REASONS[1]] } } });

    // The refresh pick that weighed Search Console goes; the other stays, and nothing says sharing stopped.
    const nu = await nextUp(db);
    expect(nu.picks.map((p) => p.questionId)).toEqual(["q_pets000000000000"]);
    expect(nu.missing).toEqual([]);
  });

  it("is safe to run again: a second run changes nothing but the count of erases", async () => {
    const db = new FakeFirestore();
    await seedFreshArticle(H, db, NOW);
    await clearSearchConsoleReasons(H, { db, now: LATER });
    const after = { watch: await watch(db), node: await card(db), nextUp: await nextUp(db) };
    expect(await clearSearchConsoleReasons(H, { db, now: new Date(LATER.getTime() + 60_000) })).toEqual({ due: 0, articles: 0, picks: 0, failed: false, finished: true });
    expect(await watch(db)).toEqual({ ...after.watch, searchConsoleClears: 2 });
    expect(await card(db)).toEqual(after.node);
    expect(await nextUp(db)).toEqual(after.nextUp);
  });

  it("does nothing for a brand the watch never looked at", async () => {
    const db = new FakeFirestore();
    expect(await clearSearchConsoleReasons(H, { db, now: LATER })).toEqual({ due: 0, articles: 0, picks: 0, failed: false, finished: true });
    expect(db.dump("freshness_watch")).toEqual([]);
  });

  it("never throws: a step that fails is logged once, with no brand content, and the others still run", async () => {
    const db = new FakeFirestore();
    await seedFreshArticle(H, db, NOW);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = await clearSearchConsoleReasons(H, { db: failingFirestore(db, { collections: ["freshness_watch"] }), now: LATER });
    expect(r).toEqual({ due: 0, articles: 1, picks: 1, failed: true, finished: true });
    expect(kinds((await card(db)).blog!.freshness!.reasons)).toEqual(["dead_link"]);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0]!.map(String).join(" ");
    expect(line).toContain("[freshness]");
    for (const content of [FRESH.title, FRESH.url, FRESH.key, ...FRESH_REASONS.map((x) => x.detail)]) expect(line).not.toContain(content);

    // Every step failing still answers, and says the articles weren't all reached.
    const down = failingFirestore(db, { collections: ["freshness_watch", "workspaces", "next_up"] });
    await expect(clearSearchConsoleReasons(H, { db: down, now: LATER })).resolves.toMatchObject({ failed: true, finished: false });
  });

  it("reaches every article, whatever the watch looks at: archived plans and programmes, and plans past the watch's newest", async () => {
    const db = new FakeFirestore();
    await seedFreshArticle(H, db, NOW);
    const stored = (await card(db)).blog!;
    const article = (id: string, workspaceId: string, over: Partial<ContentPlan> = {}) =>
      samplePlan({ id, tenantId: H.tenantId, workspaceId, name: `Care guide ${id}`, createdAt: "2026-01-02T00:00:00.000Z", ...over }, sampleHub({ status: "approved", blog: { ...BlogArticleMetaSchema.parse({}), ...stored } }));
    // An archived plan beside the live one, and a programme that is archived with an article in it.
    db.seed(`workspaces/${FRESH.workspaceId}/content_plans`, "plan_old", article("plan_old", FRESH.workspaceId, { status: "archived" }));
    db.seed("workspaces", "ws_shut", { tenantId: H.tenantId, name: "Old blog", createdAt: "2026-01-01T00:00:00.000Z", archivedAt: "2026-06-01T00:00:00.000Z" });
    db.seed("workspaces/ws_shut/content_plans", "plan_shut", article("plan_shut", "ws_shut"));
    // A programme with more plans than the watch looks at: the oldest article is past its newest.
    db.seed("workspaces", "ws_busy", { tenantId: H.tenantId, name: "Busy blog", createdAt: "2026-01-01T00:00:00.000Z" });
    for (let i = 0; i < LIVE_ARTICLES.PLANS_PER_PROGRAMME; i++) {
      const id = `plan_new${String(i).padStart(3, "0")}`;
      db.seed("workspaces/ws_busy/content_plans", id, samplePlan({ id, tenantId: H.tenantId, workspaceId: "ws_busy", createdAt: `2026-11-${String(1 + (i % 20)).padStart(2, "0")}T00:00:00.000Z` }));
    }
    db.seed("workspaces/ws_busy/content_plans", "plan_first", article("plan_first", "ws_busy"));
    // Another brand's article is never touched.
    db.seed("workspaces", "ws_other", { tenantId: "ten_other", name: "Their blog", createdAt: "2026-01-01T00:00:00.000Z" });
    db.seed("workspaces/ws_other/content_plans", "plan_theirs", article("plan_theirs", "ws_other", { tenantId: "ten_other" }));

    const seen = (await liveArticles(H, db)).map((a) => a.plan.id);
    expect(seen).toContain(FRESH.planId);
    for (const id of ["plan_old", "plan_shut", "plan_first"]) expect(seen).not.toContain(id);

    expect(await clearSearchConsoleReasons(H, { db, now: LATER })).toMatchObject({ articles: 4, failed: false, finished: true });
    const reasonsOf = async (workspaceId: string, planId: string, ctx: TenantContext = H) => kinds((await getContentPlan(ctx, workspaceId, planId, db))!.graph.nodes[0]!.blog!.freshness!.reasons);
    for (const [ws, id] of [[FRESH.workspaceId, FRESH.planId], [FRESH.workspaceId, "plan_old"], ["ws_shut", "plan_shut"], ["ws_busy", "plan_first"]] as const) {
      expect(await reasonsOf(ws, id), id).toEqual(["dead_link"]);
    }
    expect(await reasonsOf("ws_other", "plan_theirs", { ...H, tenantId: "ten_other" })).toEqual(["losing_clicks", "dead_link", "within_reach"]);
  });

  it("reads a page at a time and stops before the deadline, saying it didn't finish; the next try finishes", async () => {
    const db = new FakeFirestore();
    await seedFreshArticle(H, db, NOW);
    expect(await clearSearchConsoleArticles(H, { db, deadlineMs: Date.now() + FRESHNESS_CLEAR.MIN_LEFT_MS - 1 })).toEqual({ articles: 0, failed: false, finished: false });
    expect(kinds((await card(db)).blog!.freshness!.reasons)).toEqual(["losing_clicks", "dead_link", "within_reach"]);
    expect(await clearSearchConsoleArticles(H, { db })).toEqual({ articles: 1, failed: false, finished: true });
    expect(kinds((await card(db)).blog!.freshness!.reasons)).toEqual(["dead_link"]);
  });
});
