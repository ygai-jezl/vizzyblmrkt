import { describe, expect, it } from "vitest";
import { articleDateline, datelineText, isDayOnly, nextDates, normaliseDate, readableDay, withDateLine, zonedDay, zonedIso } from "./dates";
import { renderArticleHtml } from "./markdown";
import { suggestBlogSchema } from "./schema";
import { readPageDates } from "./research";

const NOW = new Date("2026-11-24T12:00:00.000Z");

describe("article dates", () => {
  it("keeps a day as a day, turns anything else into an instant, and refuses the future", () => {
    expect(normaliseDate("2026-04-28", NOW)).toBe("2026-04-28");
    expect(normaliseDate("2026-04-28T10:12:00+01:00", NOW)).toBe("2026-04-28T09:12:00.000Z");
    expect(normaliseDate(" 2026-11-25 ", NOW)).toBe("2026-11-25"); // a day's grace for zones ahead
    expect(normaliseDate("2026-11-27", NOW)).toBeNull();
    expect(normaliseDate("2027-01-01T00:00:00Z", NOW)).toBeNull();
    expect(normaliseDate("last Tuesday", NOW)).toBeNull();
    expect(normaliseDate(null, NOW)).toBeNull();
    expect(isDayOnly("2026-04-28")).toBe(true);
    expect(isDayOnly("2026-04-28T00:00:00Z")).toBe(false);
  });

  it("writes markup times with the zone's offset, daylight saving included", () => {
    expect(zonedIso("2026-04-28T09:12:00.000Z", "Europe/London")).toBe("2026-04-28T10:12:00+01:00");
    expect(zonedIso("2026-01-15T09:12:00.000Z", "Europe/London")).toBe("2026-01-15T09:12:00+00:00");
    expect(zonedIso("2026-07-01T16:00:00.000Z", "America/New_York")).toBe("2026-07-01T12:00:00-04:00");
    expect(zonedIso("2026-12-01T16:00:00.000Z", "America/New_York")).toBe("2026-12-01T11:00:00-05:00");
    expect(zonedIso("2026-03-10T00:00:00.000Z", "Asia/Kolkata")).toBe("2026-03-10T05:30:00+05:30");
    expect(zonedIso("2026-04-28", "Europe/London")).toBe("2026-04-28");
    expect(zonedDay("2026-04-28T23:30:00.000Z", "Europe/London")).toBe("2026-04-29");
    expect(zonedDay("2026-04-28T23:30:00.000Z", "UTC")).toBe("2026-04-28");
    expect(readableDay("2026-04-28")).toBe("28 Apr 2026");
  });

  it("takes Published from the page, else a person, else what was stored, else when first seen", () => {
    const seen = "2026-11-20T08:00:00.000Z";
    expect(nextDates(undefined, { liveAt: seen, now: NOW }).published).toEqual({ at: seen, source: "found" });
    expect(nextDates(undefined, { liveAt: seen, personDay: "2026-11-18", now: NOW }).published).toEqual({ at: "2026-11-18", source: "person" });
    const page = { published: "2026-11-17T10:00:00+00:00", modified: null };
    expect(nextDates(undefined, { page, liveAt: seen, personDay: "2026-11-18", now: NOW }).published).toEqual({ at: "2026-11-17T10:00:00.000Z", source: "page" });
    // A later check without a page date keeps what was stored, not the newer sighting.
    const stored = { published: { at: "2026-11-18", source: "person" as const } };
    expect(nextDates(stored, { liveAt: "2026-11-24T08:00:00.000Z", now: NOW }).published).toEqual({ at: "2026-11-18", source: "person" });
    // A person's day in the future, or not a day, is ignored.
    expect(nextDates(undefined, { liveAt: seen, personDay: "2026-12-30", now: NOW }).published).toEqual({ at: seen, source: "found" });
  });

  it("keeps Updated only when the page says a later day than Published, and records what the page carries", () => {
    const same = nextDates(undefined, { page: { published: "2026-11-17", modified: "2026-11-17T18:00:00Z" }, now: NOW });
    expect(same.updated).toBeUndefined();
    const later = nextDates(undefined, { page: { published: "2026-11-17", modified: "2026-11-23T09:00:00Z" }, now: NOW });
    expect(later.updated).toEqual({ at: "2026-11-23T09:00:00.000Z", source: "page" });
    expect(later.page).toEqual({ published: "2026-11-17", modified: "2026-11-23T09:00:00Z", readAt: NOW.toISOString() });
    // No page read this time: the page dates and Updated stored before stay.
    expect(nextDates(later, { liveAt: "2026-11-24T08:00:00.000Z", now: NOW })).toEqual(later);
    // A page with no dates is recorded as carrying none.
    expect(nextDates(undefined, { page: { published: null, modified: null }, liveAt: "2026-11-20T08:00:00.000Z", now: NOW }).page).toEqual({
      published: null,
      modified: null,
      readAt: NOW.toISOString(),
    });
  });

  it("keeps a refresh's Updated until the page shows that day or a later one (BLOG_REFRESH_ENABLED)", () => {
    const refreshed = { published: { at: "2026-10-03", source: "page" as const }, updated: { at: "2026-11-24T10:00:00.000Z", source: "change" as const } };
    // The page isn't republished yet: it still says the 1 November update.
    const old = nextDates(refreshed, { page: { published: "2026-10-03", modified: "2026-11-01" }, now: NOW });
    expect(old.updated).toEqual(refreshed.updated);
    // Republished: the page's own date, the same day or later, takes over.
    expect(nextDates(refreshed, { page: { published: "2026-10-03", modified: "2026-11-24T16:00:00Z" }, now: NOW }).updated).toEqual({ at: "2026-11-24T16:00:00.000Z", source: "page" });
    // A page with no dateModified leaves it too.
    expect(nextDates(refreshed, { page: { published: "2026-10-03", modified: null }, now: NOW }).updated).toEqual(refreshed.updated);
  });
});

describe("the dates a page gives itself", () => {
  it("reads meta tags, JSON-LD or a time element, and says none when it has none", () => {
    expect(readPageDates('<meta property="article:published_time" content="2026-04-28T10:12:00+01:00"><meta property="article:modified_time" content="2026-05-02">')).toEqual({
      published: "2026-04-28T10:12:00+01:00",
      modified: "2026-05-02",
    });
    expect(readPageDates('<script type="application/ld+json">{"@type":"BlogPosting","datePublished":"2026-04-28","dateModified":"2026-05-02T08:00:00Z"}</script>')).toEqual({
      published: "2026-04-28",
      modified: "2026-05-02T08:00:00Z",
    });
    expect(readPageDates('<p>Posted <time datetime="2026-04-28">28 April</time></p>')).toEqual({ published: "2026-04-28", modified: null });
    expect(readPageDates("<h1>No dates here</h1>")).toEqual({ published: null, modified: null });
  });
});

describe("the date line, the copy and the markup", () => {
  const live = { url: "https://acme.example/blog/a", at: "2026-04-28T09:12:00.000Z", by: "check" as const, titleMatched: true };
  const dates = { published: { at: "2026-04-28T09:12:00.000Z", source: "found" as const }, updated: { at: "2026-11-20", source: "page" as const } };
  const ARTICLE = "# How do I track brand citations?\n\n*Last updated: 2026-04-20 · By Ana Ruiz, Head of Growth*\n\nBody copy.";

  it("uses the stored dates once live, and today, the day it's copied, before that", () => {
    const dl = articleDateline({ live, dates }, "Europe/London", NOW);
    expect(dl).toEqual({
      published: { iso: "2026-04-28T10:12:00+01:00", text: "28 Apr 2026" },
      updated: { iso: "2026-11-20", text: "20 Nov 2026" },
      known: true,
    });
    expect(articleDateline({ dates }, "Europe/London", NOW)).toEqual({
      published: { iso: "2026-11-24T12:00:00+00:00", text: "24 Nov 2026" },
      updated: null,
      known: false,
    });
    expect(datelineText(dl, " · By Ana Ruiz, Head of Growth")).toBe("Published 28 Apr 2026 · Updated 20 Nov 2026 · By Ana Ruiz, Head of Growth");
  });

  it("puts the same dates in the copied Markdown, the HTML and the markup", () => {
    const dl = articleDateline({ live, dates }, "Europe/London", NOW);
    expect(withDateLine(ARTICLE, dl)).toBe("# How do I track brand citations?\n\n*Published 28 Apr 2026 · Updated 20 Nov 2026 · By Ana Ruiz, Head of Growth*\n\nBody copy.");
    expect(withDateLine("# No date line", dl)).toBe("# No date line");
    expect(renderArticleHtml(ARTICLE, { dateline: dl })).toContain(
      '<p class="dateline">Published <time datetime="2026-04-28T10:12:00+01:00">28 Apr 2026</time> · Updated <time datetime="2026-11-20">20 Nov 2026</time> · By Ana Ruiz, Head of Growth</p>',
    );
    // Without a dateline the export is as before.
    expect(renderArticleHtml(ARTICLE)).toContain('<p class="last-updated">Last updated: <time datetime="2026-04-20">2026-04-20</time> · By Ana Ruiz, Head of Growth</p>');
    const post = (jsonLd: unknown) => (jsonLd as { "@graph": Array<Record<string, unknown>> })["@graph"].find((n) => n["@type"] === "BlogPosting")!;
    const marked = suggestBlogSchema({ markdown: ARTICLE, dateline: dl });
    expect(post(marked.jsonLd)).toMatchObject({ datePublished: "2026-04-28T10:12:00+01:00", dateModified: "2026-11-20" });
    expect(marked.notes.join(" ")).toContain("datePublished is the day the page went up");
    const before = suggestBlogSchema({ markdown: ARTICLE, dateline: articleDateline({}, "UTC", NOW) });
    expect(post(before.jsonLd)).toMatchObject({ datePublished: "2026-11-24T12:00:00+00:00", dateModified: "2026-11-24T12:00:00+00:00" });
    expect(before.notes.join(" ")).toContain("datePublished is today, the day you copy it.");
    expect(post(suggestBlogSchema({ markdown: ARTICLE }).jsonLd)).toMatchObject({ datePublished: "2026-04-20", dateModified: "2026-04-20" });
  });
});

