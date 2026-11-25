import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PeopleFilters } from "@/lib/audience/peopleList";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
const { filterLabel, PeopleFilterBar } = await import("./PeopleFilterBar");

const filters = (over: Partial<PeopleFilters> = {}): PeopleFilters => ({
  everyone: 120,
  canEmail: 90,
  via: { form: 100, site: 0 },
  launches: [
    { id: "team-spaces", name: "Team spaces", count: 70 },
    { id: "offline-mode", name: "Offline mode", count: 60 },
  ],
  products: [],
  ...over,
});
const bar = (f: PeopleFilters, show = "all") =>
  renderToStaticMarkup(createElement(PeopleFilterBar, { filters: f, show, search: "", canEmail: false, group: null, onPick: () => {}, onCanEmail: () => {} }));

describe("In more than one launch on the People filter bar", () => {
  it("is a pill of its own with its count, pressed while it is the filter", () => {
    expect(bar(filters({ manyLaunches: 38 }))).toMatch(/aria-pressed="false"[^>]*>In more than one launch <span[^>]*>38</);
    expect(bar(filters({ manyLaunches: 38 }), "launches:many")).toMatch(/aria-pressed="true"[^>]*>In more than one launch </);
  });

  it("isn't there while ideas are off, or nobody is in more than one", () => {
    expect(bar(filters())).not.toContain("In more than one launch");
    expect(bar(filters({ manyLaunches: 0 }))).not.toContain("In more than one launch");
  });

  it("names the filter, and leaves the Launch menu alone", () => {
    expect(filterLabel("launches:many", filters({ manyLaunches: 38 }), null)).toBe("In more than one launch");
    expect(bar(filters({ manyLaunches: 38 }), "launches:many")).toMatch(/aria-haspopup="menu"[^>]*>Launch /);
  });
});
