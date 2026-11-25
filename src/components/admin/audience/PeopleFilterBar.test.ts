import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PeopleFilters } from "@/lib/audience/peopleList";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
const { filterLabel, PeopleFilterBar } = await import("./PeopleFilterBar");
const { WordsProvider } = await import("../nav/WordsProvider");

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

describe("the People filter bar while launches are called ideas", () => {
  const inWords = (f: PeopleFilters, show = "all") =>
    renderToStaticMarkup(
      createElement(
        WordsProvider,
        { ideas: true } as Parameters<typeof WordsProvider>[0],
        createElement(PeopleFilterBar, { filters: f, show, search: "", canEmail: false, group: null, onPick: () => {}, onCanEmail: () => {} }),
      ),
    );

  it("says In more than one idea and an Idea menu, as the mockup does", () => {
    const html = inWords(filters({ manyLaunches: 38 }), "launches:many");
    expect(html).toMatch(/aria-pressed="true"[^>]*>In more than one idea <span[^>]*>38</);
    expect(html).toMatch(/aria-haspopup="menu"[^>]*>Idea /);
    expect(html).not.toMatch(/\blaunch/i);
  });

  it("names each filter with the words", () => {
    const f = filters({ via: { form: 100, site: 4 } });
    expect(filterLabel("launches:many", f, null, true)).toBe("In more than one idea");
    expect(filterLabel("launch:team-spaces", f, null, true)).toBe("Idea: Team spaces");
    expect(filterLabel("launch:gone", f, null, true)).toBe("Idea: An idea");
    expect(filterLabel("via:site", f, null, true)).toBe("Idea: From your site");
    expect(filterLabel("launch:team-spaces", f, null)).toBe("Launch: Team spaces");
  });
});
