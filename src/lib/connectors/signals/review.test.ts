import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { failingFirestore } from "@/lib/tenant/testing/failingFirestore";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { changeDataConnection, forTenant, type TenantContext } from "@/lib/tenant";
import { getAgentAction } from "@/lib/ontology/agentActions";
import { isAgentActionId } from "@/lib/types/agentAction";
import { seedSearchConsole, seedSuggestion } from "../testing/signals";
import { dismissSignal, planFromSignal, planHref, signalReviewItems } from "./review";
import { getSignal } from "./store";

// Review's suggestions from collected numbers, and Plan an article and Dismiss on them. Every
// site, page, search and number is made up.
const A: TenantContext = { tenantId: "ten_a", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const B: TenantContext = { tenantId: "ten_b", region: "us", source: "idtoken", userId: "usr_b", role: "admin" };
const ID = "dcn_ssssssssssssssssssss";
const NOW = new Date("2026-11-23T10:00:00.000Z");
const DAY = 86_400_000;

let db: FakeFirestore;
const action = async (id: string) => {
  if (!isAgentActionId(id)) throw new Error("not an action id");
  return (await getAgentAction(A, id, { db }))!;
};
const workspace = (id: string, name: string, over: Record<string, unknown> = {}) => forTenant(A, db).workspaces.create(id, { name, createdAt: NOW.toISOString(), ...over } as never);

beforeEach(async () => {
  db = new FakeFirestore();
  vi.stubEnv("CONNECTORS_ENABLED", "true");
  vi.stubEnv("CONNECTORS_COLLECT_ENABLED", "true");
  vi.stubEnv("CONNECTOR_SIGNALS_ENABLED", "true");
  await seedSearchConsole(A, db, ID);
});
afterEach(() => vi.unstubAllEnvs());

describe("Review items", () => {
  it("lists each open suggestion with its words and numbers, from connections members and Vizzy may read", async () => {
    await seedSuggestion(A, db, ID, "losing");
    await seedSuggestion(A, db, ID, "reach", { now: new Date(NOW.getTime() + 1000) });
    const items = await signalReviewItems(A, { db, now: NOW });
    expect(items.map((i) => [i.title, i.details])).toEqual([
      ["“How often should I water a monstera?” could rank higher on Google", ["Average position 8.6 and 1,900 impressions for the search “how often to water monstera” in the 28 days to 20 Nov."]],
      ["Fewer Google clicks to /care/fiddle-leaf-fig", ["41 clicks in the 28 days to 20 Nov, down from 96 in the 28 days before."]],
    ]);
    for (const i of items) expect(i).toMatchObject({ kind: "data_signal", action: "Plan an article", href: "/admin/approvals#data_signal", signal: { id: expect.stringMatching(/^dsg_/) } });
    expect(items[0]!.id).toMatch(/^aa:aa_/);
    // Members only: nothing, as its numbers can't suggest anything.
    await changeDataConnection(A, ID, () => ({ patch: { grants: [{ to: "members", can: "read" }] }, activity: [] }), db);
    expect(await signalReviewItems(A, { db, now: NOW })).toEqual([]);
  });

  it("names the site when the brand has more than one Search Console connection", async () => {
    const OTHER = "dcn_tttttttttttttttttttt";
    await seedSearchConsole(A, db, OTHER, { account: "sc-domain:shop.fernhill.example" });
    await seedSuggestion(A, db, ID, "losing");
    await seedSuggestion(A, db, OTHER, "rising", { account: "sc-domain:shop.fernhill.example" });
    const lines = (await signalReviewItems(A, { db, now: NOW })).flatMap((i) => i.details ?? []);
    expect(lines).toContain("On fernhill.example: 41 clicks in the 28 days to 20 Nov, down from 96 in the 28 days before.");
    expect(lines).toContain("On shop.fernhill.example: 260 impressions in the 14 days to 20 Nov, up from 40. Nothing on your brand map answers it yet.");
  });
});

describe("Plan an article", () => {
  it("moves the suggestion to acted with its Create link, clears its values and keeps it away 30 days", async () => {
    await workspace("ws_blog", "Plant care blog");
    const { signalId, actionId } = await seedSuggestion(A, db, ID, "losing");
    const r = await planFromSignal(A, signalId, {}, { db, now: NOW, loadTenant: async () => null });
    expect(r).toEqual({ ok: true, value: { href: "/admin/workspace/ws_blog/create?numbers=page&text=%2Fcare%2Ffiddle-leaf-fig&hub=https%3A%2F%2Ffernhill.example%2Fcare%2Ffiddle-leaf-fig" } });
    // The action keeps a link with no page or search words in it; the full one went to the person.
    expect(await action(actionId)).toMatchObject({ state: "acted", proposal: null, basis: null, result: { href: "/admin/workspace/ws_blog/create?numbers=page" }, decidedBy: { type: "member", id: "usr_admin" } });
    expect(JSON.stringify((await action(actionId)).result)).not.toContain("fiddle");
    expect(JSON.stringify((await action(actionId)).signals)).not.toContain('"value"');
    expect(await getSignal(A, signalId, { db })).toMatchObject({ label: null, numbers: null, dismissedUntil: new Date(NOW.getTime() + 30 * DAY).toISOString() });
    expect(await signalReviewItems(A, { db, now: NOW })).toEqual([]);
    // Decided already: a second press changes nothing.
    expect(await planFromSignal(A, signalId, {}, { db, now: NOW, loadTenant: async () => null })).toEqual({ ok: false, error: "changed" });
  });

  it("with article freshness on, offers to refresh a page that is one of the brand's live articles, never to plan it again", async () => {
    for (const sw of ["BRAND_MAP_ENABLED", "BRAND_MAP_PAGES_ENABLED", "BLOG_DATES_ENABLED", "BLOG_FRESHNESS_ENABLED"]) vi.stubEnv(sw, "true");
    await workspace("ws_blog", "Plant care blog");
    await workspace("ws_news", "News");
    await forTenant(A, db).freshnessWatch.create("fw_ten_a", {
      nextAt: NOW.toISOString(),
      counts: { fresh: 1, soon: 0, due: 0 },
      byClock: { "20": 1, "30": 0, "45": 0 },
      pages: [{ key: "fernhill.example/care/fiddle-leaf-fig", planId: "plan_fig", workspaceId: "ws_blog" }],
      due: [],
      linksDay: "2026-11-23",
      linksToday: 0,
      updatedAt: NOW.toISOString(),
    } as never);
    const { signalId, actionId } = await seedSuggestion(A, db, ID, "losing");
    expect((await signalReviewItems(A, { db, now: NOW }))[0]).toMatchObject({ action: "Refresh this article" });
    // Two programmes and none chosen would ask which: the article's own programme answers it.
    const r = await planFromSignal(A, signalId, {}, { db, now: NOW, loadTenant: async () => null });
    expect(r).toEqual({ ok: true, value: { href: "/admin/workspace/ws_blog/create/plan_fig?freshness=1" } });
    expect(await action(actionId)).toMatchObject({ state: "acted", result: { href: "/admin/workspace/ws_blog/create/plan_fig?freshness=1" } });
  });

  it("links a question within reach to Write this next, and a search to Create with its words", () => {
    expect(planHref("ws_blog", { rule: "within_reach", label: "how often to water monstera", questionId: "q_monstera000000000", key: { topic: "how often to water monstera" } })).toBe("/admin/workspace/ws_blog/create?question=q_monstera000000000");
    expect(planHref("ws_blog", { rule: "rising_search", label: "pet safe hanging plants", questionId: null, key: { topic: "pet safe hanging plants" } })).toBe("/admin/workspace/ws_blog/create?numbers=search&text=pet%20safe%20hanging%20plants");
  });

  it("answers not_found for a suggestion Review hides, and leaves it proposed", async () => {
    await workspace("ws_blog", "Plant care blog");
    const plan = (signalId: string) => planFromSignal(A, signalId, {}, { db, now: NOW, loadTenant: async () => null });
    // A row of an older generation than the connection's (Change property, its erase not done yet).
    const old = await seedSuggestion(A, db, ID, "rising", { gen: 1 });
    await changeDataConnection(A, ID, (cur) => ({ patch: { collect: { ...cur.collect!, gen: 2 } }, activity: [] }), db);
    expect(await plan(old.signalId)).toEqual({ ok: false, error: "not_found" });
    expect((await action(old.actionId)).state).toBe("proposed");
    await changeDataConnection(A, ID, (cur) => ({ patch: { collect: { ...cur.collect!, gen: 0 } }, activity: [] }), db);
    // The brand's own connection no longer feeds planning: members only, so Review hides it.
    const { signalId, actionId } = await seedSuggestion(A, db, ID, "losing");
    await changeDataConnection(A, ID, () => ({ patch: { grants: [{ to: "members", can: "read" }] }, activity: [] }), db);
    expect(await signalReviewItems(A, { db, now: NOW })).toEqual([]);
    expect(await plan(signalId)).toEqual({ ok: false, error: "not_found" });
    expect(await action(actionId)).toMatchObject({ state: "proposed", proposal: { label: "/care/fiddle-leaf-fig" } });
    // Disconnected: the same.
    await changeDataConnection(A, ID, () => ({ patch: { grants: [{ to: "members", can: "read" }, { to: "agent:vizzy", can: "read" }], status: "disconnected" }, activity: [] }), db);
    expect(await plan(signalId)).toEqual({ ok: false, error: "not_found" });
    // Back to feeding planning: it plans.
    await changeDataConnection(A, ID, () => ({ patch: { status: "connected" }, activity: [] }), db);
    expect(await plan(signalId)).toMatchObject({ ok: true, value: { href: expect.stringContaining("/admin/workspace/ws_blog/create?numbers=page") } });
  });

  it("asks to try again, and leaves it proposed, when the connections can't be read just now", async () => {
    await workspace("ws_blog", "Plant care blog");
    const { signalId, actionId } = await seedSuggestion(A, db, ID, "losing");
    // Only the connections fail: the suggestion and its action read as usual.
    const down = failingFirestore(db, { collections: ["data_connections"] });
    expect(await planFromSignal(A, signalId, {}, { db: down, now: NOW, loadTenant: async () => null })).toEqual({ ok: false, error: "busy" });
    expect((await action(actionId)).state).toBe("proposed");
    expect(await planFromSignal(A, signalId, {}, { db, now: NOW, loadTenant: async () => null })).toMatchObject({ ok: true });
  });

  it("asks which programme when there are several, and takes the autopilot's", async () => {
    await workspace("ws_blog", "Plant care blog");
    await workspace("ws_news", "Newsletter");
    await workspace("ws_old", "Old", { archivedAt: NOW.toISOString() });
    const { signalId } = await seedSuggestion(A, db, ID, "rising");
    expect(await planFromSignal(A, signalId, {}, { db, now: NOW, loadTenant: async () => null })).toEqual({ ok: false, error: "no_programme" });
    expect(await planFromSignal(A, signalId, { workspaceId: "ws_old" }, { db, now: NOW, loadTenant: async () => null })).toEqual({ ok: false, error: "no_programme" });
    const auto = await planFromSignal(A, signalId, {}, { db, now: NOW, loadTenant: async () => ({ autopilot: { workspaceId: "ws_news" } }) as never });
    expect(auto).toMatchObject({ ok: true, value: { href: expect.stringContaining("/admin/workspace/ws_news/create?numbers=search") } });
  });
});

describe("Dismiss", () => {
  it("declines the suggestion as dismissed, clears its values and keeps its row away 30 days", async () => {
    const { signalId, actionId } = await seedSuggestion(A, db, ID, "reach");
    expect(await dismissSignal(A, signalId, { db, now: NOW })).toEqual({ ok: true, value: { dismissedUntil: new Date(NOW.getTime() + 30 * DAY).toISOString() } });
    expect(await action(actionId)).toMatchObject({ state: "declined", declined: { reason: "dismissed" }, proposal: null });
    expect(await getSignal(A, signalId, { db })).toMatchObject({ key: null, label: null, question: null, numbers: null, window: null, rule: "within_reach" });
    expect(await dismissSignal(A, signalId, { db, now: NOW })).toEqual({ ok: false, error: "changed" });
  });

  it("never reaches another brand's suggestion, or anything that isn't a suggestion id", async () => {
    const { signalId, actionId } = await seedSuggestion(A, db, ID, "losing");
    expect(await dismissSignal(B, signalId, { db, now: NOW })).toEqual({ ok: false, error: "not_found" });
    expect(await planFromSignal(B, signalId, {}, { db, now: NOW, loadTenant: async () => null })).toEqual({ ok: false, error: "not_found" });
    expect(await dismissSignal(A, "dsg_not_hex", { db, now: NOW })).toEqual({ ok: false, error: "not_found" });
    expect((await action(actionId)).state).toBe("proposed");
  });
});
