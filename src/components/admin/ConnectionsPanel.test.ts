import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
const { PROVIDER_MARKS, ProviderMark } = await import("./ConnectionsPanel");
const { BrandMark } = await import("@/components/site/BrandIcons");

describe("the Accounts tab's marks", () => {
  it("draws each account's mark from the site's brand paths, beside its name, with no words of its own", () => {
    expect(PROVIDER_MARKS).toEqual({ github: "github", gitlab: "gitlab", x: "x", linkedin: "linkedin", linkedin_org: "linkedin" });
    for (const [provider, brand] of Object.entries(PROVIDER_MARKS)) {
      const html = renderToStaticMarkup(createElement(ProviderMark, { provider: provider as keyof typeof PROVIDER_MARKS }));
      // The same path BrandIcons.tsx holds, never a copy.
      expect(html, provider).toContain(renderToStaticMarkup(createElement(BrandMark, { id: brand, size: 14 })));
      expect(html, provider).toMatch(/^<span aria-hidden="true"/);
      expect(html.replace(/<[^>]+>/g, ""), provider).toBe("");
    }
  });

  it("keeps LinkedIn and GitLab in their colours, and draws GitHub and X in the text colour, white in the dark theme", () => {
    const mark = (id: "linkedin" | "gitlab" | "github" | "x") => renderToStaticMarkup(createElement(BrandMark, { id }));
    expect(mark("linkedin")).toContain('style="color:#0A66C2"');
    expect(mark("gitlab")).toContain('style="color:#FC6D26"');
    for (const id of ["github", "x"] as const) expect(mark(id)).not.toContain("style=");
    expect(renderToStaticMarkup(createElement(ProviderMark, { provider: "github" }))).toMatch(/text-neutral-900[^"]*dark:bg-neutral-900[^"]*dark:text-white/);
    expect(renderToStaticMarkup(createElement(ProviderMark, { provider: "x" }))).toContain("dark:bg-neutral-900");
    // LinkedIn's blue mark and GitLab's orange one stay on white in the dark theme, as LinkedIn asks.
    for (const provider of ["linkedin", "linkedin_org", "gitlab"] as const) {
      const plate = renderToStaticMarkup(createElement(ProviderMark, { provider })).match(/^<span aria-hidden="true" class="([^"]*)"/)![1]!;
      expect(plate, provider).toContain("bg-white");
      expect(plate, provider).not.toMatch(/dark:bg-/);
    }
    expect(mark("github")).toMatch(/<path d="M12 \.297c-6\.63[^"]*" fill="currentColor"><\/path>/);
  });
});
