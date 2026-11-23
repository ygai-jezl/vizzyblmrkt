import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import type { AllowanceRow, FeatureRow, UsageSummary } from "@/lib/plans/usage";
import { PLAN_AND_USAGE_COPY, PlanAndUsage, PlanAndUsageFailed, PlansOff, everyPlanIncludes, needsText } from "./PlanAndUsage";

/** Text as a reader sees it: tags dropped, entities read back. */
const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const render = (summary: UsageSummary) => textOf(renderToStaticMarkup(createElement(PlanAndUsage, { summary })));

const row = (key: AllowanceRow["key"], label: string, used: number | null, limit: number | null, extra: Partial<AllowanceRow> = {}): AllowanceRow => ({
  key,
  label,
  used,
  limit,
  counted: true,
  scope: "organisation",
  perUser: false,
  capped: false,
  over: used !== null && limit !== null && used > limit,
  ...extra,
});

const feature = (f: FeatureRow["feature"], label: string, included: boolean, extra: Partial<FeatureRow> = {}): FeatureRow => ({
  feature: f,
  label,
  included,
  granted: false,
  usable: included,
  needs: null,
  ...extra,
});

/** A Pro organisation with two brands, seen by an owner (the CRM plan's mockup, made-up names). */
function proOwner(over: Partial<UsageSummary> = {}): UsageSummary {
  return {
    month: "2026-11",
    plansOn: true,
    plan: "pro",
    thisBrand: { id: "ten_north", name: "Northwind", region: "us", status: "active", liveLaunchesLimit: 5, people: 4212, liveLaunches: 2, liveLaunchesCapped: false },
    organisation: { id: "org_ten_north", name: "Northwind Group", plan: "pro", planSince: "2026-11-03T09:00:00.000Z", owner: true, view: "organisation" },
    brands: [
      { id: "ten_north", name: "Northwind", region: "us", status: "active", isThis: true, people: 4212, liveLaunches: 2, liveLaunchesCapped: false },
      { id: "ten_north_labs", name: "Northwind Labs", region: "eu", status: "suspended", isThis: false, people: 0, liveLaunches: 0, liveLaunchesCapped: false },
    ],
    allowances: [
      row("brands", "Brands", 2, 3),
      row("users", "Users", 2, null),
      row("liveIdeas", "Live launches", 2, 5, { scope: "brand" }),
      row("people", "People", 4212, 10_000),
      row("emailsPerMonth", "Emails a month", null, 5_000, { counted: false }),
      row("aiCreditsPerMonth", "AI credits a month", null, 500, { counted: false, perUser: true }),
    ],
    // Pro has no monthly feature of its own: competitor articles are granted to this brand.
    monthly: [{ feature: "competitor_articles", label: "Competitor articles", used: 12, limit: 200, from: "default", included: true, needs: null }],
    features: [
      feature("edit_vizzy", "Vizzy in Edit mode", true),
      feature("competitors", "Competitors", false, { granted: true, usable: true }),
      feature("competitor_articles", "Competitor articles", false, { granted: true, usable: true }),
      feature("brand_search", "Brand search", true, { usable: false }),
      feature("next_up", "Next up", false),
    ],
    ...over,
  };
}

describe("Plan and usage", () => {
  it("shows an owner the plan, every brand on it with its region and Suspended, and the totals", () => {
    const text = render(proOwner());
    expect(text).toContain("Your plan Northwind Group Pro");
    expect(text).toContain("Since 3 November 2026");
    expect(text).toContain("Brands on this plan");
    expect(text).toContain("Northwind United States This brand");
    expect(text).toContain("Northwind Labs Europe Suspended");
    expect(text).toContain("Your organisation");
    expect(text).toContain("Brands 2 of 3");
    expect(text).toContain("Users 2, no limit");
    expect(text).toContain(PLAN_AND_USAGE_COPY.users);
    expect(text).toContain("People 4,212 of 10,000");
    expect(text).toContain("Emails Not counted yet 5,000 a month");
    expect(text).toContain("AI credits Not counted yet 500 a month, 250 per user");
    expect(text).toContain("Live launches 2 of 5");
    expect(text).toContain("Competitor articles read 12 of 200");
    expect(text).toContain(PLAN_AND_USAGE_COPY.change);
    expect(text).not.toContain(PLAN_AND_USAGE_COPY.brandView);
    expect(text).not.toContain(PLAN_AND_USAGE_COPY.over);
  });

  it("marks each feature Included, granted, held back, or not in the plan", () => {
    const text = render(proOwner());
    expect(text).toContain("What your plan includes Launches and waitlists Journeys Posts Audience Vizzy in Edit mode");
    expect(text).toContain("Vizzy in Edit mode");
    // With People on, the area is named as the sidebar names it.
    const people = textOf(renderToStaticMarkup(createElement(PlanAndUsage, { summary: proOwner(), people: true })));
    expect(people).toContain("What your plan includes Launches and waitlists Journeys Posts People Vizzy in Edit mode");
    expect(people).not.toMatch(/\bAudience\b/);
    expect(text).toContain(`Competitors · ${PLAN_AND_USAGE_COPY.granted}`);
    expect(text).toContain(`Brand search · ${PLAN_AND_USAGE_COPY.heldBack}`);
    expect(text).toContain(`${PLAN_AND_USAGE_COPY.notIncluded} Next up`);
  });

  it("shows someone who isn't an owner only this brand, and says who sees the rest", () => {
    // Combined brands keep the name of the brand the organisation was made for, here the other
    // brand's. Usage leaves it out in brand view, and the page never prints it there either.
    const text = render(
      proOwner({
        organisation: { id: "org_ten_north_labs", name: "Northwind Labs", plan: "pro", planSince: "2026-11-03T09:00:00.000Z", owner: false, view: "brand" },
        brands: null,
        allowances: null,
      }),
    );
    expect(text).toContain(PLAN_AND_USAGE_COPY.brandView);
    expect(text).toContain("Since 3 November 2026");
    expect(text).not.toContain("Northwind Labs");
    expect(text).not.toContain("Brands on this plan");
    expect(text).not.toContain("Your organisation");
    expect(text).toContain("This brand · Northwind");
    expect(text).toContain("People 4,212");
  });

  it("shows a one-brand Free organisation near its limits, and the over line past one", () => {
    const fern: UsageSummary = {
      month: "2026-11",
      plansOn: true,
      plan: "free",
      thisBrand: { id: "ten_fern", name: "Fernleaf", region: "eu", status: "active", liveLaunchesLimit: 1, people: 912, liveLaunches: 2, liveLaunchesCapped: false },
      organisation: { id: "org_ten_fern", name: "Fernleaf", plan: "free", planSince: "2026-11-01T00:00:00.000Z", owner: false, view: "organisation" },
      brands: [{ id: "ten_fern", name: "Fernleaf", region: "eu", status: "active", isThis: true, people: 912, liveLaunches: 2, liveLaunchesCapped: false }],
      allowances: [
        row("brands", "Brands", 1, 1),
        row("users", "Users", 1, 2),
        row("liveIdeas", "Live launches", 2, 1, { scope: "brand" }),
        row("people", "People", 912, 1_000),
        row("emailsPerMonth", "Emails a month", null, 1_000, { counted: false }),
        row("aiCreditsPerMonth", "AI credits a month", null, 50, { counted: false }),
      ],
      monthly: [],
      features: [feature("edit_vizzy", "Vizzy in Edit mode", false), feature("competitors", "Competitors", false)],
    };
    const text = render(fern);
    expect(text).toContain("Free");
    expect(text).toContain("Brands 1 of 1");
    expect(text).toContain("Users 1 of 2");
    expect(text).toContain("People 912 of 1,000");
    expect(text).toContain("AI credits Not counted yet 50 a month");
    expect(text).toContain("Live launches 2 of 1");
    expect(text).toContain(PLAN_AND_USAGE_COPY.over);
    // Free adds no feature of its own, so what every plan has is listed: never an empty heading.
    expect(text).toContain(`What your plan includes Launches and waitlists Journeys Posts Audience ${PLAN_AND_USAGE_COPY.notIncluded} Vizzy in Edit mode Competitors`);
  });

  it("says everything is open for a brand with no plan, and for Self-hosted", () => {
    const open = render(proOwner({ plan: null, organisation: null, brands: null, allowances: null, monthly: [] }));
    expect(open).toContain(PLAN_AND_USAGE_COPY.noPlan);
    expect(open).toContain("What this brand can use");
    expect(open).toContain("Live launches 2");
    expect(open).not.toContain("Your organisation");

    const self = render(
      proOwner({
        plan: "self_hosted",
        organisation: { id: "org_ten_demo", name: "Acme", plan: "self_hosted", planSince: "2026-11-01T00:00:00.000Z", owner: true, view: "organisation" },
        brands: [{ id: "ten_demo", name: "Acme", region: "us", status: "active", isThis: true, people: 3, liveLaunches: 1, liveLaunchesCapped: false }],
        thisBrand: { id: "ten_demo", name: "Acme", region: "us", status: "active", liveLaunchesLimit: null, people: 3, liveLaunches: 1, liveLaunchesCapped: false },
        allowances: [
          row("brands", "Brands", 1, null),
          row("users", "Users", 1, null),
          row("people", "People", 3, null),
          row("emailsPerMonth", "Emails a month", null, null, { counted: false }),
          row("aiCreditsPerMonth", "AI credits a month", null, null, { counted: false }),
        ],
      }),
    );
    expect(self).toContain("Self-hosted");
    expect(self).toContain(PLAN_AND_USAGE_COPY.selfHosted);
    expect(self).toContain("Brands 1, no limit");
    expect(self).toContain("Emails Not counted yet Your email provider");
    expect(self).toContain("Live launches 1, no limit");
  });

  it("says when a count failed, and when a monthly feature isn't in the plan", () => {
    const text = render(
      proOwner({
        thisBrand: { id: "ten_north", name: "Northwind", region: "us", status: "active", liveLaunchesLimit: 5, people: null, liveLaunches: null, liveLaunchesCapped: false },
        monthly: [{ feature: "next_up", label: "Next up", used: 0, limit: 100, from: "default", included: false, needs: null }],
      }),
    );
    expect(text).toContain(`People ${PLAN_AND_USAGE_COPY.couldNotCount}`);
    expect(text).toContain(`Google lookups for Next up ${PLAN_AND_USAGE_COPY.notInPlan}`);
  });

  it("says what a feature granted on its own still needs, never that it is ready", () => {
    // No plan has the autopilot without Next up, but a brand's own grant can give it alone.
    const text = render(
      proOwner({
        monthly: [{ feature: "article_autopilot", label: "Article autopilot", used: 0, limit: 8, from: "default", included: false, needs: "next_up" }],
        features: [feature("article_autopilot", "Article autopilot", false, { granted: true, usable: false, needs: "next_up" }), feature("next_up", "Next up", false)],
      }),
    );
    expect(needsText("next_up")).toBe("Needs Next up");
    expect(text).toContain("Autopilot drafts Needs Next up");
    expect(text).toContain("Article autopilot · Needs Next up");
    expect(text).toContain(`${PLAN_AND_USAGE_COPY.notIncluded} Next up`);
    expect(text).not.toContain(`${PLAN_AND_USAGE_COPY.notIncluded} Article autopilot`);
    expect(text).not.toContain("Autopilot drafts 0 of 8");
  });

  it("shows each paid resource this month: searches of a cap, model use in tokens with no limit, by feature and model", () => {
    const text = render(
      proOwner({
        monthly: [
          { feature: "web_searches", label: "Web searches for research", used: 140, limit: 1500, from: "plan", included: true, needs: null, unit: "searches", byPurpose: { blog_research: 120, brand_map_research: 20 } },
          {
            feature: "model_tokens",
            label: "AI model use",
            used: 9000,
            limit: null,
            from: null,
            included: true,
            needs: null,
            unit: "tokens",
            byPurpose: { vizzy_chat: 6000, blog_write: 3000 },
            byModel: { "gemini-3.8-flash": 9000 },
          },
          { feature: "images", label: "Images made", used: null, limit: 100_000, from: "default", included: true, needs: null, unit: "images" },
        ],
        organisationResources: [
          { resource: "model_tokens", label: "AI model use", unit: "tokens", used: 10_000 },
          { resource: "images", label: "Images made", unit: "images", used: null },
        ],
      }),
    );
    expect(text).toContain("Web searches for research 140 of 1,500");
    expect(text).toContain("Blog research 120 · Brand map research 20");
    expect(text).toContain("AI model use 9,000 tokens, no limit");
    expect(text).toContain("gemini-3.8-flash 9,000");
    expect(text).toContain(`Images made ${PLAN_AND_USAGE_COPY.couldNotCount}`);
    // The organisation's totals: a brand that couldn't be read is never a low number.
    expect(text).toContain("AI model use 10,000 tokens");
    expect(text).not.toMatch(/Images made 0\b/);
    expect(dashesIn(text)).toEqual([]);
    expect(aiTellsIn(text)).toEqual([]);
  });

  it("has a neutral line when plans are off, never coming soon", () => {
    const off = textOf(renderToStaticMarkup(createElement(PlansOff)));
    expect(off).toBe(PLAN_AND_USAGE_COPY.plansOff);
    expect(off).not.toMatch(/coming soon/i);
    expect(textOf(renderToStaticMarkup(createElement(PlanAndUsageFailed)))).toBe(PLAN_AND_USAGE_COPY.failed);
  });

  it("keeps to the writing rules", () => {
    for (const text of [...Object.values(PLAN_AND_USAGE_COPY), ...everyPlanIncludes(false), ...everyPlanIncludes(true)]) {
      expect(dashesIn(text), text).toEqual([]);
      expect(aiTellsIn(text), text).toEqual([]);
    }
    const page = render(proOwner());
    expect(dashesIn(page)).toEqual([]);
    expect(aiTellsIn(page)).toEqual([]);
    // Never a bare "Plan" heading: content plans, person plans and the autopilot use the word.
    expect(renderToStaticMarkup(createElement(PlanAndUsage, { summary: proOwner() }))).not.toMatch(/<h[23][^>]*>Plan<\/h[23]>/);
  });
});
