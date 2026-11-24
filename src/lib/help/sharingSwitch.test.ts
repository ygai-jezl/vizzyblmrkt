import { afterEach, describe, expect, it, vi } from "vitest";
import { CONNECTOR_ERRORS } from "@/lib/connectors/messages";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";

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

  it("on: Connected data says what a part from your organisation is, its states and messages, and Review says who fixes one", async () => {
    vi.stubEnv("CONNECTORS_COLLECT_ENABLED", "true");
    const { helpPageMarkdown } = await load(true);
    const connected = helpPageMarkdown("connected-data", "https://app.example.com")!;
    expect(connected).toContain("## A part from your organisation");
    expect(connected).toMatch(/^\| Needs, with your organisation's name \|/m);
    expect(connected).toMatch(/^\| Ended \|/m);
    expect(connected).toContain(`"${CONNECTOR_ERRORS.managed_by_organisation}"`);
    expect(connected).toContain(`"${CONNECTOR_ERRORS.part_ended}"`);
    const review = helpPageMarkdown("review-and-approvals", "https://app.example.com")!;
    expect(review).toContain("Search Console from Acme Group can't be read since 21 Nov");
    expect(review).toContain("[A part from your organisation](https://app.example.com/help/connected-data.md)");
    expect(helpPageMarkdown("shared-connections", "https://app.example.com")).toContain("[Connected data](https://app.example.com/help/connected-data.md)");
    // The section the Review page links to is there while sharing is on.
    const { HELP_BODIES } = await import("@/components/help/bodies");
    const { renderToStaticMarkup } = await import("react-dom/server");
    expect(renderToStaticMarkup(HELP_BODIES["connected-data"]!({ sharing: true }) as never)).toContain('id="from-organisation"');
    const part = connected.slice(connected.indexOf("## A part from your organisation"));
    expect(dashesIn(part)).toEqual([]);
    expect(aiTellsIn(part)).toEqual([]);
    expect(aiTellsIn(review)).toEqual([]);
    for (const line of [...connected.split("\n"), ...review.split("\n")]) {
      expect(/[–—]/.test(line) || /\S - \S/.test(line), line).toBe(false);
    }
  });

  it("off: no part section on Connected data, and Review says nothing of an organisation", async () => {
    vi.stubEnv("CONNECTORS_COLLECT_ENABLED", "true");
    const { helpPageMarkdown } = await load(false);
    expect(helpPageMarkdown("connected-data", "https://app.example.com")).not.toContain("A part from your organisation");
    expect(helpPageMarkdown("connected-data", "https://app.example.com")).not.toContain(CONNECTOR_ERRORS.managed_by_organisation);
    expect(helpPageMarkdown("review-and-approvals", "https://app.example.com")).not.toContain("Settings › Organisation");
  });
});
