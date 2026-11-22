import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * /help/connected-data and its How to rules exist only with NEXT_PUBLIC_CONNECTORS_ENABLED. The
 * places rules are fixed when the module loads (the switch is fixed at build time), so each case
 * loads it afresh.
 */
async function load(on: boolean) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_CONNECTORS_ENABLED", on ? "true" : "false");
  const [places, pages, agent] = await Promise.all([import("./places"), import("./pages"), import("./agentFiles")]);
  return { ...places, ...pages, ...agent };
}

describe("the connected data help switch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("off: no Connected data page, and every Connections page opens Connected accounts as before", async () => {
    const { helpFor, HELP_PLACES, shownHelpPages, helpLlmsTxt, helpPageMarkdown } = await load(false);
    expect(helpFor("/admin/account/connections/browse")).toBe("/help/connected-accounts");
    expect(helpFor("/admin/account/connections/connected")).toBe("/help/connected-accounts");
    expect(HELP_PLACES.some((p) => p.startsWith("/help/connected-data"))).toBe(false);
    expect(shownHelpPages().map((p) => p.slug)).not.toContain("connected-data");
    expect(helpLlmsTxt("https://app.example.com")).not.toContain("connected-data");
    expect(helpPageMarkdown("connected-accounts", "https://app.example.com")).not.toContain("Connected data");
  });

  it("on: the page is listed and the rules point at its sections", async () => {
    const { helpFor, shownHelpPages, helpLlmsTxt } = await load(true);
    expect(helpFor("/admin/account/connections/cloudflare")).toBe("/help/connected-data#connect");
    expect(helpFor("/admin/account/connections")).toBe("/help/connected-accounts");
    expect(shownHelpPages().map((p) => p.slug)).toContain("connected-data");
    expect(helpLlmsTxt("https://app.example.com")).toContain("https://app.example.com/help/connected-data.md");
  });
});
