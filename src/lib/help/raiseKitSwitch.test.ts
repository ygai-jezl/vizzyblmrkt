import { afterEach, describe, expect, it, vi } from "vitest";
import { UK_PROMOTION_REMINDER } from "@/lib/raise/docs/words";

/**
 * /help/raise-kit exists only while RAISE_KIT_ENABLED is on. It is a server switch, so the pages read
 * it when they render; the How to rule for Content › Raise kit needs none, because those pages exist
 * only then too.
 */
async function load(on: boolean) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_HELP_PAGES_ENABLED", "true");
  vi.stubEnv("RAISE_KIT_ENABLED", on ? "true" : "false");
  const [places, pages, agent, md] = await Promise.all([import("./places"), import("./pages"), import("./agentFiles"), import("@/app/help/raise-kit.md/route")]);
  return { ...places, ...pages, ...agent, md };
}

describe("the Raise kit help switch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("off: no Raise kit page, and its Markdown copy is not found", async () => {
    const { shownHelpPages, helpLlmsTxt, md } = await load(false);
    expect(shownHelpPages().map((p) => p.slug)).not.toContain("raise-kit");
    expect(helpLlmsTxt("https://app.example.com")).not.toContain("raise-kit");
    expect((await md.GET()).status).toBe(404);
  });

  it("on: listed after Write and schedule, served as Markdown with the UK reminder, and How to on the Raise kit opens it", async () => {
    const { shownHelpPages, helpLlmsTxt, helpPageMarkdown, helpFor, md } = await load(true);
    const slugs = shownHelpPages().map((p) => p.slug);
    expect(slugs.indexOf("raise-kit")).toBe(slugs.indexOf("write-and-schedule") + 1);
    expect(helpLlmsTxt("https://app.example.com")).toContain("https://app.example.com/help/raise-kit.md");
    expect((await md.GET()).status).toBe(200);
    const text = helpPageMarkdown("raise-kit", "https://app.example.com")!;
    expect(text).toMatch(/^# Raise kit\n/);
    expect(text).toContain(UK_PROMOTION_REMINDER);
    expect(text).toContain("Fernhill Plants");
    expect(helpFor("/admin/raise")).toBe("/help/raise-kit");
    expect(helpFor("/admin/raise/rd_acme00000001")).toBe("/help/raise-kit");
    // Content itself keeps its own page.
    expect(helpFor("/admin/workspace")).toBe("/help/programmes-and-knowledge#start");
  });
});
