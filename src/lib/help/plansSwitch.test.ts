import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * /help/plan-and-usage and its How to rules exist only with NEXT_PUBLIC_PLANS_ENABLED. The places
 * rules are fixed when the module loads (the switch is fixed at build time), so each case loads
 * it afresh.
 */
async function load(on: boolean) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_PLANS_ENABLED", on ? "true" : "false");
  const [places, pages] = await Promise.all([import("./places"), import("./pages")]);
  return { ...places, ...pages };
}

describe("the plans help switch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("off: no Plan and usage page, and Add Brand points at Get set up as before", async () => {
    const { helpFor, HELP_PLACES, shownHelpPages } = await load(false);
    expect(helpFor("/admin/brands/new")).toBe("/help#brand");
    expect(helpFor("/admin/account/billing")).toBe("/help");
    expect(HELP_PLACES.some((p) => p.startsWith("/help/plan-and-usage"))).toBe(false);
    expect(shownHelpPages().map((p) => p.slug)).not.toContain("plan-and-usage");
  });

  it("on: the page is listed right after Get set up, and both rules point at it", async () => {
    const { helpFor, shownHelpPages } = await load(true);
    expect(helpFor("/admin/brands/new")).toBe("/help/plan-and-usage#brands");
    expect(helpFor("/admin/account/billing")).toBe("/help/plan-and-usage");
    expect(shownHelpPages().map((p) => p.slug).slice(0, 2)).toEqual(["", "plan-and-usage"]);
  });
});
