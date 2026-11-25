import { describe, expect, it } from "vitest";
import { MEANINGS, numberKeys } from "@/lib/metrics/meanings";
import type { TenantContext } from "@/lib/tenant/types";
import { agentUsage } from "./agentApi";
import type { UsageSummary } from "./usage";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "agent", userId: "u1", role: "admin" };

const summary = (over: Partial<UsageSummary> = {}): UsageSummary =>
  ({
    month: "2026-11",
    plansOn: true,
    plan: "pro",
    thisBrand: {} as never,
    organisation: null,
    brands: null,
    allowances: null,
    features: [],
    monthly: [
      { feature: "next_up", label: "Next up", used: 12, limit: 100, from: "default", included: true, needs: null, byPurpose: { get_from_google: 9, autopilot: 3 } },
      { feature: "web_searches", label: "Web searches for research", unit: "searches", used: 140, limit: 1500, from: "plan", included: true, needs: null, byPurpose: { blog_research: 120, brand_map_research: 20 } },
      { feature: "model_tokens", label: "AI model use", unit: "tokens", used: 250_000, limit: null, from: null, included: true, needs: null, byPurpose: { blog_write: 200_000, vizzy_chat: 50_000 }, byModel: { "gemini-3.8-flash": 250_000 } },
    ],
    ...over,
  }) as UsageSummary;

describe("get_usage", () => {
  it("gives each row with what's left and what used it, every number with a meaning", async () => {
    const r = await agentUsage(ctx, { summary: async () => summary() });
    const body = r.body as { thisBrand: Array<Record<string, unknown>>; meanings: Record<string, unknown> };
    expect(r.status).toBe(200);
    expect(body.thisBrand.find((x) => x.key === "web_searches")).toMatchObject({
      usedThisMonth: 140,
      monthlyLimit: 1500,
      leftThisMonth: 1360,
      byFeature: [
        { feature: "Blog research", usedThisMonth: 120 },
        { feature: "Brand map research", usedThisMonth: 20 },
      ],
    });
    expect(body.thisBrand.find((x) => x.key === "model_tokens")).toMatchObject({ monthlyLimit: null, leftThisMonth: null, byModel: [{ model: "gemini-3.8-flash", usedThisMonth: 250_000 }] });
    // The contract: every number in the answer has a meaning, and nothing else is a number.
    for (const key of numberKeys(r.body)) expect(MEANINGS, key).toHaveProperty(key);
    expect(Object.keys(body.meanings).sort()).toEqual(["leftThisMonth", "monthlyLimit", "usedThisMonth"]);
  });

  it("names what used model time in a month counted before and after the writing split, and keeps a key it doesn't know", async () => {
    const model = (byPurpose: Record<string, number>) =>
      summary({ monthly: [{ feature: "model_tokens", label: "AI model use", unit: "tokens", used: 1000, limit: null, from: null, included: true, needs: null, byPurpose }] });
    const r = await agentUsage(ctx, {
      summary: async () => model({ content_write: 500, content_email: 200, content_hub: 150, content_brief: 80, content_angle: 50, retired_feature: 20 }),
    });
    const rows = (r.body as { thisBrand: Array<{ key: string; byFeature: unknown }> }).thisBrand;
    expect(rows.find((x) => x.key === "model_tokens")?.byFeature).toEqual([
      { feature: "Writing posts", usedThisMonth: 500 },
      { feature: "Writing workflow emails", usedThisMonth: 200 },
      { feature: "Writing hub content", usedThisMonth: 150 },
      { feature: "Writing briefs", usedThisMonth: 80 },
      { feature: "Suggesting angles", usedThisMonth: 50 },
      { feature: "retired_feature", usedThisMonth: 20 },
    ]);
  });

  it("adds the organisation's totals only when the summary has them (owners)", async () => {
    const plain = await agentUsage(ctx, { summary: async () => summary() });
    expect(plain.body).not.toHaveProperty("organisation");
    const owner = await agentUsage(ctx, {
      summary: async () =>
        summary({
          organisation: { id: "org_1", name: "Acme", plan: "pro", planSince: "", owner: true, view: "organisation" },
          brands: [{ id: "ten_A", name: "Acme", region: "us", status: "active", isThis: true } as never],
          organisationResources: [{ resource: "web_searches", label: "Web searches for research", unit: "searches", used: 400 }],
        }),
    });
    expect(owner.body).toMatchObject({ organisation: { name: "Acme", brandNames: ["Acme"], thisMonth: [{ key: "web_searches", usedThisMonth: 400 }] } });
  });
});
