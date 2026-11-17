import { describe, expect, it } from "vitest";
import { diffBaselines, worthReanalysing } from "./diff";
import type { BaselinePage } from "./sitemap";

const pages = (...keys: string[]): BaselinePage[] => keys.map((key) => ({ key, lastmod: null }));

describe("a month's changes", () => {
  it("lists pages added and removed by section, after a whole read", () => {
    const before = pages("/", "/news/a", "/news/b", "/pricing");
    const after = pages("/", "/news/a", "/news/c", "/locations/leeds", "/locations/york");
    const d = diffBaselines(before, after, { whole: true });
    expect(d.added.count).toBe(3);
    expect(d.added.sections).toEqual([
      { section: "/locations/", count: 2, sample: ["/locations/leeds", "/locations/york"] },
      { section: "/news/", count: 1, sample: ["/news/c"] },
    ]);
    expect(d.removed.count).toBe(2);
    expect(d.appeared).toEqual(["/locations/"]);
    expect(d.gone).toEqual(["/pricing/"]);
    expect(d.next).toBe(after);
    expect(worthReanalysing(d, before.length)).toBe(true);
  });

  it("after a read that wasn't whole, reports no removals and keeps the pages it didn't see", () => {
    const before = pages("/a", "/b", "/c");
    const after = pages("/a", "/d");
    const d = diffBaselines(before, after, { whole: false });
    expect(d.added.count).toBe(1);
    expect(d.removed.count).toBe(0);
    expect(d.gone).toEqual([]);
    expect(d.next.map((p) => p.key).sort()).toEqual(["/a", "/b", "/c", "/d"]);
  });

  it("isn't worth new words for a small change to a big site", () => {
    const before = pages(...Array.from({ length: 100 }, (_, i) => `/blog/${i}`));
    const after = pages(...Array.from({ length: 101 }, (_, i) => `/blog/${i}`));
    expect(worthReanalysing(diffBaselines(before, after, { whole: true }), 100)).toBe(false);
  });
});
