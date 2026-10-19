import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const { ImageStyleCard } = await import("./ImageStyleCard");

function render(props: Partial<Parameters<typeof ImageStyleCard>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(ImageStyleCard, { initial: null, suggestion: null, palette: ["#5b4fe6"], canEdit: true, ...props }),
  );
}

describe("ImageStyleCard", () => {
  it("lists the 13 styles, with the unbuilt ones marked Coming and not choosable", () => {
    const html = render();
    expect((html.match(/aria-pressed="(true|false)"/g) ?? []).length).toBeGreaterThanOrEqual(13);
    expect((html.match(/>Coming</g) ?? []).length).toBe(4);
    expect(html).toContain("Product noir");
    expect(html).toContain("Default (Today&#x27;s presets)");
  });

  it("marks the saved default and names it in the per-channel menus", () => {
    const html = render({ initial: { defaultStyleId: "natural_photo" } });
    expect(html).toContain(">Default<");
    expect(html).toContain("Default (Natural photo)");
  });

  it("shows Vizzy's suggestion with Review and Dismiss for an admin, and read-only for a member", () => {
    const suggestion = { defaultStyleId: "product_noir" as const, reason: "Your site shows product screens.", suggestedAt: "2026-10-19T10:00:00Z" };
    const admin = render({ suggestion });
    expect(admin).toContain("Vizzy suggests Product noir.");
    expect(admin).toContain(">Review<");
    const member = render({ suggestion, canEdit: false });
    expect(member).not.toContain(">Review<");
    expect(member).toContain("Only an admin can change the image style.");
  });
});
