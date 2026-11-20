import { afterEach, describe, expect, it, vi } from "vitest";
import { isPlansEnabled, isPlansUiEnabled, newOrganisationPlan } from "./flags";

describe("plans flags", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("are off unless exactly true", () => {
    vi.stubEnv("PLANS_ENABLED", "");
    vi.stubEnv("NEXT_PUBLIC_PLANS_ENABLED", "TRUE");
    expect(isPlansEnabled()).toBe(false);
    expect(isPlansUiEnabled()).toBe(false);
    vi.stubEnv("PLANS_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_PLANS_ENABLED", "true");
    expect(isPlansEnabled()).toBe(true);
    expect(isPlansUiEnabled()).toBe(true);
  });

  it("starts new organisations on Self-hosted unless a known plan is set", () => {
    vi.stubEnv("PLANS_NEW_ORGANISATION_PLAN", "");
    expect(newOrganisationPlan()).toBe("self_hosted");
    vi.stubEnv("PLANS_NEW_ORGANISATION_PLAN", "platinum");
    expect(newOrganisationPlan()).toBe("self_hosted");
    vi.stubEnv("PLANS_NEW_ORGANISATION_PLAN", "free");
    expect(newOrganisationPlan()).toBe("free");
    vi.stubEnv("PLANS_NEW_ORGANISATION_PLAN", " Pro ");
    expect(newOrganisationPlan()).toBe("pro");
  });

  it("starts new organisations on Self-hosted when the setting is missing", () => {
    vi.stubEnv("PLANS_NEW_ORGANISATION_PLAN", undefined as unknown as string);
    expect(newOrganisationPlan()).toBe("self_hosted");
  });
});
