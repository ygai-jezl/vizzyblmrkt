import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * /help/history-and-restore exists only while SETTINGS_HISTORY_ENABLED is on. It is a server switch,
 * so the pages read it when they render; the How to rule for Settings › History needs none, because
 * that page exists only then too.
 */
async function load(on: boolean) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_HELP_PAGES_ENABLED", "true");
  vi.stubEnv("SETTINGS_HISTORY_ENABLED", on ? "true" : "false");
  vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
  vi.stubEnv("AUDIENCE_ONE_VIEW_ENABLED", "true");
  vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", "true");
  vi.stubEnv("AUDIENCE_FIELDS_ENABLED", "true");
  const [places, pages, agent, md] = await Promise.all([import("./places"), import("./pages"), import("./agentFiles"), import("@/app/help/history-and-restore.md/route")]);
  return { ...places, ...pages, ...agent, md };
}

describe("the settings history help switch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("off: no History and restore page, its Markdown copy is not found, and Data model's help keeps its old line", async () => {
    const { shownHelpPages, helpLlmsTxt, helpPageMarkdown, md } = await load(false);
    expect(shownHelpPages().map((p) => p.slug)).not.toContain("history-and-restore");
    expect(helpLlmsTxt("https://app.example.com")).not.toContain("history-and-restore");
    expect((await md.GET()).status).toBe(404);
    const audience = helpPageMarkdown("your-audience", "https://app.example.com")!;
    expect(audience).toContain("Restoring an older list comes with settings history.");
    expect(audience).not.toContain("history-and-restore");
  });

  it("on: listed before Why isn't this working?, served as Markdown, linked from Data model's help, and How to on Settings › History opens it", async () => {
    const { shownHelpPages, helpLlmsTxt, helpPageMarkdown, helpFor, md } = await load(true);
    const slugs = shownHelpPages().map((p) => p.slug);
    expect(slugs.indexOf("history-and-restore")).toBe(slugs.indexOf("troubleshooting") - 1);
    expect(helpLlmsTxt("https://app.example.com")).toContain("https://app.example.com/help/history-and-restore.md");
    expect((await md.GET()).status).toBe(200);
    const audience = helpPageMarkdown("your-audience", "https://app.example.com")!;
    expect(audience).toContain("[History](https://app.example.com/help/history-and-restore.md)");
    expect(audience).toContain("See them all, and restore one, in Settings › History.");
    expect(helpFor("/admin/account/history")).toBe("/help/history-and-restore");
  });
});
