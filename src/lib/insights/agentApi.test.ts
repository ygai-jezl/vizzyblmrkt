import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { __resetRateLimitState } from "@/lib/tenant/rateLimit";
import type { TenantContext } from "@/lib/tenant/types";
import { signCanvasContext } from "@/lib/canvas/auth";
import { agentInsightsSummary, insightsAgentGate } from "./agentApi";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "agent", userId: "u1", role: "admin" };
const NOW = new Date("2026-09-24T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const FLAGS = [
  "NEXT_PUBLIC_NAV_V2_ENABLED",
  "NEXT_PUBLIC_NAV_V2_PHASE2_ENABLED",
  "NEXT_PUBLIC_NAV_V2_PHASE3_ENABLED",
  "NEXT_PUBLIC_NAV_V2_PHASE4_ENABLED",
  "NEXT_PUBLIC_INSIGHTS_HUB_ENABLED",
];
const OPTS = { lifecycle: false, invites: false, now: NOW };
const req = (token?: string) =>
  new Request("https://app.example.com/api/agent/insights/summary", { headers: token ? { "x-canvas-context": token } : {} });

beforeEach(() => {
  __resetRateLimitState();
  for (const f of FLAGS) vi.stubEnv(f, "true");
  vi.stubEnv("CANVAS_CONTEXT_SIGNING_KEY", "test-only-canvas-key");
});
afterEach(() => vi.unstubAllEnvs());

describe("Vizzy's Insights summary", () => {
  it("needs the Insights flag and a valid canvas token, and takes the tenant from the token", () => {
    vi.stubEnv("NEXT_PUBLIC_INSIGHTS_HUB_ENABLED", "false");
    expect(insightsAgentGate(req(signCanvasContext(ctx)))).toMatchObject({ ok: false, result: { status: 503 } });
    vi.stubEnv("NEXT_PUBLIC_INSIGHTS_HUB_ENABLED", "true");
    expect(insightsAgentGate(req())).toMatchObject({ ok: false, result: { status: 401 } });
    expect(insightsAgentGate(req("forged.token"))).toMatchObject({ ok: false, result: { status: 401 } });
    expect(insightsAgentGate(req(signCanvasContext(ctx)))).toMatchObject({ ok: true, ctx: { tenantId: "ten_A", source: "agent" } });
  });

  it("returns aggregates only: weekly signups and sources, never a person", async () => {
    const db = new FakeFirestore();
    const signup = (id: string, createdAt: string, over: Record<string, unknown> = {}) =>
      db.seed("signups", id, {
        tenantId: "ten_A",
        campaignId: "beta",
        status: "verified_active",
        verified: true,
        email: `${id}@example.com`,
        firstName: "Ada",
        createdAt,
        ...over,
      });
    signup("s1", daysAgo(1), { utm: { source: "linkedin", campaign: "dinner-carousel" } });
    signup("s2", daysAgo(2));
    signup("s3", daysAgo(9), { referredBySignupToken: "t1" });

    const r = await agentInsightsSummary(ctx, OPTS, db);
    expect(r.status).toBe(200);
    const body = r.body as {
      signups: { thisWeek: number; lastWeek: number; weekly: unknown[] };
      sources: { rows: unknown[]; contentCampaigns: unknown[]; note: string };
      funnel: unknown;
    };
    expect(body.signups).toMatchObject({ thisWeek: 2, lastWeek: 1 });
    expect(body.signups.weekly).toHaveLength(12);
    expect(body.sources.rows).toContainEqual({ source: "linkedin", label: "LinkedIn", signups: 1, content: true });
    expect(body.sources.contentCampaigns).toEqual([{ utmCampaign: "dinner-carousel", signups: 1 }]);
    expect(body.sources.note).toContain("estimated");
    expect(body.funnel).toBeNull();
    const json = JSON.stringify(body);
    expect(json).not.toContain("@");
    expect(json).not.toContain("Ada");
  });

  it("is rate-limited per tenant", async () => {
    const db = new FakeFirestore();
    for (let i = 0; i < 10; i += 1) expect((await agentInsightsSummary(ctx, OPTS, db)).status).toBe(200);
    expect((await agentInsightsSummary(ctx, OPTS, db)).status).toBe(429);
  });
});
