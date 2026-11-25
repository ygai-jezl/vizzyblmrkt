import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * /help/organisation-brands (Connectors 3 group 4) exists only while ORGANISATION_JOIN_ENABLED is on,
 * with PLANS_ENABLED. It is a server switch, so the pages read it when they render, and the header
 * tells the How to rule for Settings › Organisation when only the join is on.
 */
async function load(on: boolean, sharing = false) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_HELP_PAGES_ENABLED", "true");
  vi.stubEnv("NEXT_PUBLIC_PLANS_ENABLED", "true");
  vi.stubEnv("NEXT_PUBLIC_CONNECTORS_ENABLED", "true");
  vi.stubEnv("CONNECTORS_ENABLED", "true");
  vi.stubEnv("PLANS_ENABLED", "true");
  vi.stubEnv("CONNECTORS_SHARING_ENABLED", sharing ? "true" : "false");
  vi.stubEnv("ORGANISATION_JOIN_ENABLED", on ? "true" : "false");
  const [places, pages, agent, md] = await Promise.all([import("./places"), import("./pages"), import("./agentFiles"), import("@/app/help/organisation-brands.md/route")]);
  return { ...places, ...pages, ...agent, md };
}

describe("the brands in your organisation help switch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("off: no page, its Markdown copy is not found, and Plan and usage doesn't link to it", async () => {
    const { shownHelpPages, helpLlmsTxt, helpPageMarkdown, md } = await load(false);
    expect(shownHelpPages().map((p) => p.slug)).not.toContain("organisation-brands");
    expect(helpLlmsTxt("https://app.example.com")).not.toContain("organisation-brands");
    expect((await md.GET()).status).toBe(404);
    expect(helpPageMarkdown("plan-and-usage", "https://app.example.com")).not.toContain("Brands in your organisation");
  });

  it("off with plans off too: the page stays hidden whatever its own switch says", async () => {
    const { shownHelpPages } = await load(true);
    vi.stubEnv("PLANS_ENABLED", "false");
    expect(shownHelpPages().map((p) => p.slug)).not.toContain("organisation-brands");
  });

  it("on: listed after Plan and usage, served as Markdown, linked from Plan and usage", async () => {
    const { shownHelpPages, helpLlmsTxt, helpPageMarkdown, md } = await load(true);
    const slugs = shownHelpPages().map((p) => p.slug);
    expect(slugs.indexOf("organisation-brands")).toBe(slugs.indexOf("plan-and-usage") + 1);
    expect(helpLlmsTxt("https://app.example.com")).toContain("https://app.example.com/help/organisation-brands.md");
    expect((await md.GET()).status).toBe(200);
    expect(helpPageMarkdown("plan-and-usage", "https://app.example.com")).toContain("[Brands in your organisation](https://app.example.com/help/organisation-brands.md)");
  });

  it("How to on Settings › Organisation opens Brands with only the join on, and Shared connections otherwise", async () => {
    const { helpFor } = await load(true);
    expect(helpFor("/admin/account/organisation", { organisation: "brands" })).toBe("/help/organisation-brands");
    expect(helpFor("/admin/account/organisation")).toBe("/help/shared-connections");
    expect(helpFor("/admin/account/connections", { organisation: "brands" })).toBe("/help/connected-accounts");
  });

  it("says what a move does to shared parts only while sharing is on", async () => {
    const off = (await load(true)).helpPageMarkdown("organisation-brands", "https://app.example.com")!;
    expect(off).not.toContain("parts from");
    const on = (await load(true, true)).helpPageMarkdown("organisation-brands", "https://app.example.com")!;
    expect(on).toContain("Its parts from the organisation it leaves stop at once");
    expect(on).toContain("keep serving the brands left");
  });
});
