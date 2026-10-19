import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlogArticleMetaSchema, type ContentNode } from "@/lib/types/contentPlan";
import { BlogHeroCard } from "./BlogHeroCard";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const controls = { make: vi.fn(), upload: vi.fn(), setAlt: vi.fn(), busyId: null, assetUrl: (r: string) => `/asset/${r}` };
const node = (hero?: Record<string, unknown>) =>
  ({
    id: "hub",
    type: "hub",
    channel: "blog",
    role: "Hub",
    body: "# How to pick a CRM\n\nStart here.",
    blog: BlogArticleMetaSchema.parse(hero ? { hero } : {}),
  }) as unknown as ContentNode;
const html = (n: ContentNode, busyId: string | null = null) =>
  renderToStaticMarkup(createElement(BlogHeroCard, { node: n, controls: { ...controls, busyId } }));
const made = { status: "ready", styleId: "headline_card", heroRef: "h.png", shareRef: "s.png", alt: "A desk", forTitle: "How to pick a CRM" };

describe("BlogHeroCard", () => {
  it("an article without one offers to make it", () => {
    const out = html(node());
    expect(out).toContain("No hero image yet.");
    expect(out).toContain("Make hero image");
  });

  it("shows the hero, the share card and its style", () => {
    const out = html(node(made));
    expect(out).toContain('src="/asset/h.png"');
    expect(out).toContain('src="/asset/s.png"');
    expect(out).toContain("Headline card.");
    expect(out).toContain("Make again");
    expect(out).not.toContain("The title changed");
  });

  it("says when it's a title card, being made, or made for an older title", () => {
    expect(html(node({ ...made, status: "fallback", styleId: "title_card" }))).toContain("Try the image again");
    expect(html(node(made), "hub")).toContain("Making the hero image");
    expect(html(node({ ...made, forTitle: "An older title" }))).toContain("The title changed since this was made.");
  });

  describe("formats (IMAGE_FORMATS_ENABLED)", () => {
    afterEach(() => vi.unstubAllEnvs());
    it("offers the Format menu, names the format, and says when a chart stepped down", () => {
      vi.stubEnv("NEXT_PUBLIC_BRAND_IMAGE_STYLE_ENABLED", "true");
      vi.stubEnv("NEXT_PUBLIC_IMAGE_FORMATS_ENABLED", "true");
      const out = html(node({ ...made, format: "report_cover", formatInputs: { title: "T" } }));
      expect(out).toContain("Report cover in Headline card.");
      expect(out).toContain('aria-label="Title"');
      expect(html(node({ ...made, styleId: "type_poster", note: "no_numbers" }))).toContain("Not enough checked numbers in the article for a chart");
    });
    it("without the switch, no Format menu", () => {
      expect(html(node(made))).not.toContain("Partner lockup");
    });
  });
});
