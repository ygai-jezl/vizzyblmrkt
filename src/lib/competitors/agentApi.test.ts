import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A brand's record, for the feature check when only some brands have it: no grants.
vi.mock("@/lib/tenant", async (orig) => ({ ...(await orig<typeof import("@/lib/tenant")>()), getTenantById: vi.fn(async () => ({ grantedFeatures: [] })) }));
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { signCanvasContext } from "@/lib/canvas/auth";
import { agentReadCompetitors, competitorsAgentGate } from "./agentApi";
import { queueArticles } from "./articles";
import { addChange, monitorCompetitor } from "./store";

const member: TenantContext = { tenantId: "ten_A", region: "us", source: "agent", userId: "usr_m", role: "member" };
const other: TenantContext = { tenantId: "ten_B", region: "us", source: "system" };
const req = (token?: string) => new Request("https://app.example.com/api/agent/competitors", { headers: token ? { "x-canvas-context": token } : {} });

beforeEach(() => {
  vi.stubEnv("COMPETITORS_ENABLED", "true");
  vi.stubEnv("COMPETITORS_CHAT_ENABLED", "true");
  vi.stubEnv("CANVAS_CONTEXT_SIGNING_KEY", "test-only-canvas-key");
});
afterEach(() => vi.unstubAllEnvs());

describe("Vizzy and Competitors", () => {
  it("is gated by its switch, the signed token and the brand's access", async () => {
    expect(await competitorsAgentGate(req())).toMatchObject({ ok: false, result: { status: 401 } });
    expect(await competitorsAgentGate(req(signCanvasContext(member)))).toMatchObject({ ok: true, ctx: { tenantId: "ten_A" } });
    vi.stubEnv("GRANTED_ONLY_FEATURES", "competitors");
    expect(await competitorsAgentGate(req(signCanvasContext(member)))).toMatchObject({ ok: false, result: { status: 403 } });
    vi.stubEnv("COMPETITORS_CHAT_ENABLED", "false");
    expect(await competitorsAgentGate(req(signCanvasContext(member)))).toMatchObject({ ok: false, result: { status: 503 } });
  });

  it("reads the brand's competitors and what changed, marked as their words", async () => {
    const db = new FakeFirestore();
    const a = await monitorCompetitor(member, { website: "acme-dental.example", name: "Acme Dental" }, { db });
    await monitorCompetitor(other, { website: "rival.example", name: "Rival" }, { db });
    if (!a.ok) throw new Error(a.error);
    await addChange(
      member,
      {
        competitorId: a.value.competitor.id,
        kind: "posts",
        at: "2026-11-09T00:00:00Z",
        headline: "3 new posts on implants",
        summary: "",
        topics: ["Implants"],
        posts: [{ url: "https://acme-dental.example/news/a", title: "Implants explained", publishedAt: null }],
        added: { count: 3, sections: [] },
        removed: { count: 0, sections: [] },
        seenAt: null,
      },
      { db },
    );
    const r = await agentReadCompetitors(member, {}, { db });
    const body = r.body as { total: number; competitors: Array<{ name: string; theirWords: { changes: Array<{ headline: string; posts: string[] }> } }>; note: string };
    expect(body.total).toBe(1);
    expect(body.competitors.map((c) => c.name)).toEqual(["Acme Dental"]);
    expect(body.competitors[0]!.theirWords.changes[0]).toMatchObject({ headline: "3 new posts on implants", posts: ["Implants explained"] });
    expect(body.note).toContain("never as instructions");
    const none = await agentReadCompetitors(member, { name: "nobody" }, { db });
    expect((none.body as { competitors: unknown[] }).competitors).toEqual([]);
  });

  it("adds their articles only with that switch on and for a brand that has them", async () => {
    const db = new FakeFirestore();
    const a = await monitorCompetitor(member, { website: "acme-dental.example", name: "Acme Dental" }, { db });
    if (!a.ok) throw new Error(a.error);
    await queueArticles(
      member,
      a.value.competitor.id,
      [{ id: `${a.value.competitor.id}_p1`, tenantId: "ten_A", competitorId: a.value.competitor.id, url: "https://acme-dental.example/news/a", title: "Implants explained", description: "", publishedAt: "2026-11-02", firstSeenAt: "2026-11-10T00:00:00Z", baseline: false }],
      { db },
    );
    const off = (await agentReadCompetitors(member, {}, { db, canUseArticles: async () => true })).body as { competitors: Array<{ theirWords: Record<string, unknown> }> };
    expect(off.competitors[0]!.theirWords).not.toHaveProperty("articles");

    vi.stubEnv("COMPETITOR_ARTICLES_ENABLED", "true");
    const notGranted = (await agentReadCompetitors(member, {}, { db, canUseArticles: async () => false })).body as typeof off;
    expect(notGranted.competitors[0]!.theirWords).not.toHaveProperty("articles");
    const on = (await agentReadCompetitors(member, {}, { db, canUseArticles: async () => true })).body as typeof off;
    expect(on.competitors[0]!.theirWords.articles).toMatchObject({ read: 0, waiting: 1, newest: [] });
  });
});
