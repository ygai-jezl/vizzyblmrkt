import { describe, expect, it, vi } from "vitest";
import { NO_USAGE, type UrlReadResult } from "@/lib/agents/gemini";
import { googleReadPosts, googleReadRobots, googleReadSitemap, titleFromSlug, wasRead, withoutSiteName, type ReadWithGoogle } from "./google";

const OK = "URL_RETRIEVAL_STATUS_SUCCESS";
const ERROR = "URL_RETRIEVAL_STATUS_ERROR";
const B = "https://blocked.example";

/** Google's answer: its text, and which addresses it read. */
const reads = (text: string, retrieved: Array<[string, string]>): ReadWithGoogle =>
  vi.fn(async () => ({ text, retrieved: retrieved.map(([url, status]) => ({ url, status })), model: "m" }) satisfies UrlReadResult);

describe("reading through Google", () => {
  it("trusts an answer only for an address Google says it read", async () => {
    const robots = "User-agent: *\nAllow: /\nSitemap: https://www.blocked.example/sitemap.xml";
    expect(await googleReadRobots(`${B}/robots.txt`, 5000, NO_USAGE, { readWithGoogle: reads(`\`\`\`\n${robots}\n\`\`\``, [[`${B}/robots.txt`, OK]]) })).toBe(robots);
    // The model may still write an answer when Google couldn't read the file: never used.
    expect(await googleReadRobots(`${B}/robots.txt`, 5000, NO_USAGE, { readWithGoogle: reads(robots, [[`${B}/robots.txt`, ERROR]]) })).toBeNull();
    expect(await googleReadRobots(`${B}/robots.txt`, 5000, NO_USAGE, { readWithGoogle: reads("CANNOT_READ", [[`${B}/robots.txt`, OK]]) })).toBeNull();
    expect(await googleReadRobots(`${B}/robots.txt`, 5000, NO_USAGE, { readWithGoogle: vi.fn(async () => null) })).toBeNull();
    // One address asked and one read counts, even named after a redirect.
    expect(wasRead({ text: "", retrieved: [{ url: "https://www.blocked.example/robots.txt", status: OK }], model: "m" }, `${B}/robots.txt`)).toBe(true);
  });

  it("keeps only sitemap lines that are addresses on their site, with a date or nothing after them", async () => {
    const text = [
      "Here is the sitemap:",
      "KIND: urlset",
      `${B}/blog/one\t2026-11-12T10:00:00+00:00`,
      `http://blocked.example/blog/two\t2026-11-10`,
      `${B}/blog/three`,
      `${B}/blog/three\t2026-11-01`,
      "https://elsewhere.example/blog/four\t2026-11-11",
      `${B}/blog/five - a post about whitening`,
      `${B}/blog/six\tyesterday`,
      "/blog/seven\t2026-11-09",
    ].join("\n");
    const got = await googleReadSitemap(`${B}/blog/post-sitemap.xml`, { site: "blocked.example", max: 300, usage: NO_USAGE }, 5000, {
      readWithGoogle: reads(text, [[`${B}/blog/post-sitemap.xml`, OK]]),
    });
    expect(got).toEqual({
      kind: "urlset",
      entries: [
        { loc: `${B}/blog/one`, lastmod: "2026-11-12T10:00:00+00:00" },
        { loc: `${B}/blog/two`, lastmod: "2026-11-10" },
        { loc: `${B}/blog/three`, lastmod: null },
      ],
    });
  });

  it("tells an index from a list of pages, caps the lines, and gives nothing for a file Google couldn't read", async () => {
    const index = await googleReadSitemap(`${B}/sitemap.xml`, { site: "blocked.example", max: 300, usage: NO_USAGE }, 5000, {
      readWithGoogle: reads(`${B}/blog/post-sitemap.xml\n${B}/page-sitemap.xml`, [[`${B}/sitemap.xml`, OK]]),
    });
    expect(index).toMatchObject({ kind: "index" });
    const many = Array.from({ length: 50 }, (_, i) => `${B}/blog/p${i}\t2026-11-01`).join("\n");
    const capped = await googleReadSitemap(`${B}/blog/post-sitemap.xml`, { site: "blocked.example", max: 30, usage: NO_USAGE }, 5000, {
      readWithGoogle: reads(`KIND: urlset\n${many}`, [[`${B}/blog/post-sitemap.xml`, OK]]),
    });
    expect(capped !== "no_answer" && capped?.entries).toHaveLength(30);
    expect(
      await googleReadSitemap(`${B}/sitemap.xml`, { site: "blocked.example", max: 300, usage: NO_USAGE }, 5000, {
        readWithGoogle: reads(`KIND: urlset\n${B}/blog/one`, [[`${B}/sitemap.xml`, ERROR]]),
      }),
    ).toBeNull();
    // The call failing (a timeout) is not the same as Google failing to read the file: worth asking again.
    expect(await googleReadSitemap(`${B}/sitemap.xml`, { site: "blocked.example", max: 300, usage: NO_USAGE }, 5000, { readWithGoogle: vi.fn(async () => null) })).toBe("no_answer");
  });

  it("keeps a post's title only for an address we asked about that Google read", async () => {
    const asked = [`${B}/blog/one`, `${B}/blog/two`, `${B}/blog/three`];
    const text = [
      `${B}/blog/one\tOpening hours over the holidays\t2026-11-16`,
      `${B}/blog/two/\tWhitening myths\t`,
      `${B}/blog/three\tA post Google couldn't read\t2026-11-15`,
      `${B}/blog/made-up\tA post nobody asked about\t2026-11-14`,
    ].join("\n");
    const got = await googleReadPosts(asked, 5000, NO_USAGE, {
      readWithGoogle: reads(text, [
        [`${B}/blog/one`, OK],
        [`${B}/blog/two`, OK],
        [`${B}/blog/three`, ERROR],
      ]),
    });
    expect([...got]).toEqual([
      [`${B}/blog/one`, { title: "Opening hours over the holidays", publishedAt: "2026-11-16" }],
      [`${B}/blog/two`, { title: "Whitening myths", publishedAt: null }],
    ]);
  });

  it("makes a title from the address when Google couldn't read the post", () => {
    expect(titleFromSlug(`${B}/blog/opening-hours/`)).toBe("Opening hours");
    expect(titleFromSlug(`${B}/news/same_day_implants.html`)).toBe("Same day implants");
    expect(titleFromSlug(`${B}/`)).toBe("");
  });

  it("drops a short site name after a bar from a post's title", () => {
    expect(withoutSiteName("Whitening myths | Acme Dental")).toBe("Whitening myths");
    expect(withoutSiteName("Whitening myths")).toBe("Whitening myths");
    expect(withoutSiteName("Prices | Opening hours | Acme Dental")).toBe("Prices | Opening hours");
  });
});
