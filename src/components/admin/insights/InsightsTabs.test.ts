import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/admin/analytics/launches" }));
const { WordsProvider } = await import("../nav/WordsProvider");
const { InsightsTabs } = await import("./InsightsTabs");

const render = (ideas: boolean) =>
  renderToStaticMarkup(createElement(WordsProvider, { ideas } as Parameters<typeof WordsProvider>[0], createElement(InsightsTabs, { market: false })));

describe("Insights' tabs", () => {
  it("call the launches tab Ideas with the words on, keeping its address", () => {
    const html = render(true);
    expect(html).toContain('href="/admin/analytics/launches">Ideas</a>');
    expect(html).toContain(">Ideas<");
    expect(html).not.toContain(">Launches<");
  });

  it("call it Launches with the words off", () => {
    expect(render(false)).toContain(">Launches<");
  });
});
