import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import type { AllowanceRow, FeatureRow, UsageSummary } from "@/lib/plans/usage";
import { PLAN_AND_USAGE_COPY, PlanAndUsage, PlanAndUsageFailed, PlansOff } from "./PlanAndUsage";

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
    monthly: [{ feature: "article_autopilot", label: "Article autopilot", used: 1, limit: 4, from: "plan", included: true }],
    features: [
      feature("edit_vizzy", "Vizzy in Edit mode", true),
      feature("competitors", "Competitors", false, { granted: true, usable: true }),
      feature("brand_search", "Brand search", true, { usable: false }),
      feature("next_up", "Next up", false),
    ],
    ...over,
  };
}

describe("Plan and usage", () => {
  it("shows an owner the plan, every brand on it with its region and Suspended, and the totals", () => {
    const text = render(proOwner());
    expect(text).toContain("Your plan Pro");
    expect(text).toContain("Northwind Group · Since 3 November 2026");
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
    expect(text).toContain("Autopilot drafts 1 of 4");
    expect(text).toContain(PLAN_AND_USAGE_COPY.change);
    expect(text).not.toContain(PLAN_AND_USAGE_COPY.brandView);
    expect(text).not.toContain(PLAN_AND_USAGE_COPY.over);
  });

  it("marks each feature Included, granted, held back, or not in the plan", () => {
    const text = render(proOwner());
    expect(text).toContain("What your plan includes");
    expect(text).toContain("Vizzy in Edit mode");
    expect(text).toContain(`Competitors · ${PLAN_AND_USAGE_COPY.granted}`);
    expect(text).toContain(`Brand search · ${PLAN_AND_USAGE_COPY.heldBack}`);
    expect(text).toContain(`${PLAN_AND_USAGE_COPY.notIncluded} Next up`);
  });

  it("shows someone who isn't an owner only this brand, and says who sees the rest", () => {
    const text = render(
      proOwner({
        organisation: { id: "org_ten_north", name: "Northwind Group", plan: "pro", planSince: "2026-11-03T09:00:00.000Z", owner: false, view: "brand" },
        brands: null,
        allowances: null,
      }),
    );
    expect(text).toContain(PLAN_AND_USAGE_COPY.brandView);
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
    expect(text).toContain(`${PLAN_AND_USAGE_COPY.notIncluded} Vizzy in Edit mode Competitors`);
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
        monthly: [{ feature: "next_up", label: "Next up", used: 0, limit: 100, from: "default", included: false }],
      }),
    );
    expect(text).toContain(`People ${PLAN_AND_USAGE_COPY.couldNotCount}`);
    expect(text).toContain(`Google lookups for Next up ${PLAN_AND_USAGE_COPY.notInPlan}`);
  });

  it("has a neutral line when plans are off, never coming soon", () => {
    const off = textOf(renderToStaticMarkup(createElement(PlansOff)));
    expect(off).toBe(PLAN_AND_USAGE_COPY.plansOff);
    expect(off).not.toMatch(/coming soon/i);
    expect(textOf(renderToStaticMarkup(createElement(PlanAndUsageFailed)))).toBe(PLAN_AND_USAGE_COPY.failed);
  });

  it("keeps to the writing rules", () => {
    for (const text of Object.values(PLAN_AND_USAGE_COPY)) {
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
