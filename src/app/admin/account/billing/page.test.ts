import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageSummary } from "@/lib/plans/usage";

const { requireAdminContext, organisationUsage } = vi.hoisted(() => ({
  requireAdminContext: vi.fn(),
  organisationUsage: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ requireAdminContext }));
vi.mock("@/lib/plans/usage", () => ({ organisationUsage }));

const { default: AccountBillingPage } = await import("./page");
const { PLAN_AND_USAGE_COPY } = await import("@/components/admin/plans/PlanAndUsage");

const CTX = { tenantId: "ten_demo", region: "us" as const, userId: "uid_owner", role: "admin" as const, source: "idtoken" as const };

const SUMMARY: UsageSummary = {
  month: "2026-11",
  plansOn: true,
  plan: "self_hosted",
  thisBrand: { id: "ten_demo", name: "Acme", region: "us", status: "active", liveLaunchesLimit: null, people: 3, liveLaunches: 1, liveLaunchesCapped: false },
  organisation: null,
  brands: null,
  allowances: null,
  monthly: [],
  features: [],
};

async function renderPage(): Promise<string> {
  return renderToStaticMarkup((await AccountBillingPage()) as ReactElement).replace(/&#x27;/g, "'");
}

describe("Settings › Plan and usage", () => {
  beforeEach(() => {
    requireAdminContext.mockResolvedValue(CTX);
    organisationUsage.mockResolvedValue(SUMMARY);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    delete process.env.PLANS_ENABLED;
    delete process.env.NEXT_PUBLIC_PLANS_ENABLED;
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("is today's Billing placeholder with the UI switch off, and reads nothing", async () => {
    process.env.PLANS_ENABLED = "true";
    const html = await renderPage();
    expect(html).toContain("Billing is coming soon.");
    expect(requireAdminContext).toHaveBeenCalled();
    expect(organisationUsage).not.toHaveBeenCalled();
  });

  it("says plans are off with only the UI switch on, never coming soon", async () => {
    process.env.NEXT_PUBLIC_PLANS_ENABLED = "true";
    const html = await renderPage();
    expect(html).toContain(PLAN_AND_USAGE_COPY.plansOff);
    expect(html).not.toContain("coming soon");
    expect(organisationUsage).not.toHaveBeenCalled();
  });

  it("shows the plan for the signed-in brand with both switches on", async () => {
    process.env.PLANS_ENABLED = "true";
    process.env.NEXT_PUBLIC_PLANS_ENABLED = "true";
    const html = await renderPage();
    expect(organisationUsage).toHaveBeenCalledWith(CTX);
    expect(html).toContain("Self-hosted");
    expect(html).toContain(PLAN_AND_USAGE_COPY.selfHosted);
  });

  it("says it didn't load when the figures can't be read", async () => {
    process.env.PLANS_ENABLED = "true";
    process.env.NEXT_PUBLIC_PLANS_ENABLED = "true";
    organisationUsage.mockRejectedValue(new Error("unavailable"));
    const html = await renderPage();
    expect(html).toContain(PLAN_AND_USAGE_COPY.failed);
  });
});
