import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BlogArticleFreshnessSchema, type BlogArticleFreshness } from "@/lib/types/contentPlan";
import { FreshnessCard, NOT_LOOKED_YET } from "./FreshnessCard";

// A made-up live article on the 20-day clock in the clock test.
const live = { url: "https://acme.example/blog/a", at: "2026-10-20T09:00:00.000Z", by: "operator" as const, titleMatched: false };
const fresh = (over: Partial<BlogArticleFreshness> = {}): BlogArticleFreshness =>
  BlogArticleFreshnessSchema.parse({
    clockDays: 20,
    arm: "test",
    assignedAt: "2026-10-20T09:00:00.000Z",
    checkedAt: null,
    state: "due",
    reasons: [
      { kind: "age", detail: "35 days since its last update or check, on a 20-day clock", hard: true },
      { kind: "dead_link", detail: "1 link no longer opens", hard: true },
    ],
    dueAt: "2026-11-09T09:00:00.000Z",
    sweptAt: "2026-11-24T06:00:00.000Z",
    ...over,
  });
const html = (props: Parameters<typeof FreshnessCard>[0]) => renderToStaticMarkup(createElement(FreshnessCard, props));
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const check = async () => ({ ok: true });

describe("the Freshness card", () => {
  it("shows nothing until the article is live, then waits for the watch's first look", () => {
    expect(html({ live: null, freshness: fresh(), onChecked: check })).toBe("");
    expect(text(html({ live, freshness: undefined, onChecked: check }))).toBe(`Freshness ${NOT_LOOKED_YET}`);
  });

  it("gives the state, the clock, every reason and the check", () => {
    const t = text(html({ live, freshness: fresh(), onChecked: check }));
    expect(t).toContain("Due a refresh");
    expect(t).toContain("On the 20-day clock, in the clock test · due since 9 Nov 2026");
    expect(t).toContain("35 days since its last update or check, on a 20-day clock");
    expect(t).toContain("1 link no longer opens");
    expect(t).toContain("Checked, nothing to change");
  });

  it("names a brand's one clock and the last check, and offers no check while fresh or read only", () => {
    const t = text(html({ live, freshness: fresh({ arm: "fixed", clockDays: 30, state: "soon", checkedAt: "2026-11-01T10:00:00.000Z", reasons: [] }), onChecked: check }));
    expect(t).toContain("Review soon");
    expect(t).toContain("Every 30 days · due 9 Nov 2026 · last checked 1 Nov 2026");
    expect(html({ live, freshness: fresh({ state: "fresh", reasons: [] }), onChecked: check })).not.toContain("Checked, nothing to change");
    expect(html({ live, freshness: fresh() })).not.toContain("Checked, nothing to change");
  });
});
