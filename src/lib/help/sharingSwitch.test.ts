import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * /help/shared-connections (Connectors 3) exists only while CONNECTORS_SHARING_ENABLED is on, with
 * CONNECTORS_ENABLED and PLANS_ENABLED. It is a server switch, so the pages read it when they render;
 * the How to rule for Settings › Organisation needs none, because that page exists only then too.
 */
async function load(on: boolean) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_HELP_PAGES_ENABLED", "true");
  vi.stubEnv("NEXT_PUBLIC_CONNECTORS_ENABLED", "true");
  vi.stubEnv("NEXT_PUBLIC_PLANS_ENABLED", "true");
  vi.stubEnv("CONNECTORS_ENABLED", "true");
  vi.stubEnv("PLANS_ENABLED", "true");
  vi.stubEnv("CONNECTORS_SHARING_ENABLED", on ? "true" : "false");
  const [places, pages, agent, md] = await Promise.all([import("./places"), import("./pages"), import("./agentFiles"), import("@/app/help/shared-connections.md/route")]);
  return { ...places, ...pages, ...agent, md };
}

describe("the shared connections help switch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("off: no Shared connections page, its Markdown copy is not found, and no other page links to it", async () => {
    const { shownHelpPages, helpLlmsTxt, helpPageMarkdown, md } = await load(false);
    expect(shownHelpPages().map((p) => p.slug)).not.toContain("shared-connections");
    expect(helpLlmsTxt("https://app.example.com")).not.toContain("shared-connections");
    expect((await md.GET()).status).toBe(404);
    expect(helpPageMarkdown("connected-data", "https://app.example.com")).not.toContain("Shared connections");
    expect(helpPageMarkdown("plan-and-usage", "https://app.example.com")).not.toContain("Shared connections");
  });

  it("off with plans or connectors off too: the page stays hidden whatever its own switch says", async () => {
    const { shownHelpPages } = await load(true);
    vi.stubEnv("PLANS_ENABLED", "false");
    expect(shownHelpPages().map((p) => p.slug)).not.toContain("shared-connections");
    vi.stubEnv("PLANS_ENABLED", "true");
    vi.stubEnv("CONNECTORS_ENABLED", "false");
    expect(shownHelpPages().map((p) => p.slug)).not.toContain("shared-connections");
  });

  it("on: listed after Connected data, served as Markdown, linked from Connected data and Plan and usage, and How to on Settings › Organisation opens it", async () => {
    const { shownHelpPages, helpLlmsTxt, helpPageMarkdown, helpFor, md } = await load(true);
    const slugs = shownHelpPages().map((p) => p.slug);
    expect(slugs.indexOf("shared-connections")).toBe(slugs.indexOf("connected-data") + 1);
    expect(helpLlmsTxt("https://app.example.com")).toContain("https://app.example.com/help/shared-connections.md");
    expect((await md.GET()).status).toBe(200);
    expect(helpPageMarkdown("connected-data", "https://app.example.com")).toContain("[Shared connections](https://app.example.com/help/shared-connections.md)");
    expect(helpPageMarkdown("plan-and-usage", "https://app.example.com")).toContain("[Shared connections](https://app.example.com/help/shared-connections.md)");
    expect(helpFor("/admin/account/organisation")).toBe("/help/shared-connections");
  });
});
