import { afterEach, describe, expect, it, vi } from "vitest";
import { forTenant } from "@/lib/tenant";
import { failingFirestore } from "@/lib/tenant/testing/failingFirestore";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { getContentPlan } from "@/lib/tenant/workspaceContent";
import { nextUpDocId } from "@/lib/types/autopilot";
import { clearSearchConsoleReasons } from "./freshnessErase";
import { freshnessWatchId } from "./freshnessPages";
import { FRESH, FRESH_REASONS, seedFreshArticle } from "./testing/freshness";

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
    expect(await clearSearchConsoleReasons(H, { db, now: LATER })).toEqual({ due: 1, articles: 1, picks: 1, failed: false });

    const w = await watch(db);
    expect(kinds(w.due[0]!.reasons)).toEqual(["dead_link"]);
    expect(w).toEqual({ ...before.watch, nextAt: LATER.toISOString(), due: [{ ...before.watch.due[0]!, reasons: [FRESH_REASONS[1]] }] });

    // Nothing else on the article changes: its body, status, live mark, dates and the rest of its freshness.
    const node = await card(db);
    expect(kinds(node.blog!.freshness!.reasons)).toEqual(["dead_link"]);
    expect(node).toEqual({ ...before.node, blog: { ...before.node.blog!, freshness: { ...before.node.blog!.freshness!, reasons: [FRESH_REASONS[1]] } } });

    // The refresh pick that weighed Search Console goes; the other stays, and nothing says sharing stopped.
    const nu = await nextUp(db);
    expect(nu.picks.map((p) => p.questionId)).toEqual(["q_pets000000000000"]);
    expect(nu.missing).toEqual([]);
  });

  it("is safe to run again: a second run changes nothing", async () => {
    const db = new FakeFirestore();
    await seedFreshArticle(H, db, NOW);
    await clearSearchConsoleReasons(H, { db, now: LATER });
    const after = { watch: await watch(db), node: await card(db), nextUp: await nextUp(db) };
    expect(await clearSearchConsoleReasons(H, { db, now: new Date(LATER.getTime() + 60_000) })).toEqual({ due: 0, articles: 0, picks: 0, failed: false });
    expect(await watch(db)).toEqual(after.watch);
    expect(await card(db)).toEqual(after.node);
    expect(await nextUp(db)).toEqual(after.nextUp);
  });

  it("does nothing for a brand the watch never looked at", async () => {
    const db = new FakeFirestore();
    expect(await clearSearchConsoleReasons(H, { db, now: LATER })).toEqual({ due: 0, articles: 0, picks: 0, failed: false });
    expect(db.dump("freshness_watch")).toEqual([]);
  });

  it("never throws: a step that fails is logged once, with no brand content, and the others still run", async () => {
    const db = new FakeFirestore();
    await seedFreshArticle(H, db, NOW);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = await clearSearchConsoleReasons(H, { db: failingFirestore(db, { collections: ["freshness_watch"] }), now: LATER });
    expect(r).toEqual({ due: 0, articles: 1, picks: 1, failed: true });
    expect(kinds((await card(db)).blog!.freshness!.reasons)).toEqual(["dead_link"]);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0]!.map(String).join(" ");
    expect(line).toContain("[freshness]");
    for (const content of [FRESH.title, FRESH.url, FRESH.key, ...FRESH_REASONS.map((x) => x.detail)]) expect(line).not.toContain(content);

    // Every step failing still answers.
    const down = failingFirestore(db, { collections: ["freshness_watch", "workspaces", "next_up"] });
    await expect(clearSearchConsoleReasons(H, { db: down, now: LATER })).resolves.toMatchObject({ failed: true });
  });
});
