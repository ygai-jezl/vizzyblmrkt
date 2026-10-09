import { describe, expect, it } from "vitest";
import { AI_CRAWLERS, blockedCrawlers, crawlerLabel, parseRobots } from "./crawlers";

const all = AI_CRAWLERS.map((c) => c.agent);

describe("which AI crawlers a robots.txt keeps out", () => {
  it("keeps nobody out when there are no rules, or only an empty Disallow", () => {
    expect(blockedCrawlers("")).toEqual([]);
    expect(blockedCrawlers("User-agent: *\nDisallow:\n\nSitemap: https://acme.example/sitemap.xml")).toEqual([]);
  });

  it("keeps everyone out when everyone is told to stay away", () => {
    expect(blockedCrawlers("User-agent: *\nDisallow: /")).toEqual(all);
  });

  it("finds the crawlers named on their own — the usual way an AI crawler gets blocked", () => {
    const robots = ["# keep the AI bots out", "User-agent: GPTBot", "User-agent: ClaudeBot", "Disallow: /", "", "User-agent: *", "Allow: /"].join("\n");
    expect(blockedCrawlers(robots)).toEqual(["GPTBot", "ClaudeBot"]);
    // The name is matched whatever its capitals, and a comment is not part of it.
    expect(blockedCrawlers("user-agent: perplexitybot # sorry\ndisallow: /")).toEqual(["PerplexityBot"]);
  });

  it("gives a crawler its own group's rules, not everyone's, once it is named", () => {
    const robots = ["User-agent: *", "Disallow: /", "", "User-agent: Googlebot", "Disallow: /admin/"].join("\n");
    expect(blockedCrawlers(robots, "/blog/post")).toEqual(all.filter((a) => a !== "Googlebot"));
  });

  it("reads the rules for the article's own path", () => {
    const robots = ["User-agent: *", "Disallow: /blog/drafts/", "Disallow: /private"].join("\n");
    expect(blockedCrawlers(robots, "/blog/how-it-works")).toEqual([]);
    expect(blockedCrawlers(robots, "/blog/drafts/how-it-works")).toEqual(all);
    expect(blockedCrawlers(robots, "/")).toEqual([]);
  });

  it("lets the longest matching rule decide, and Allow win a tie", () => {
    const robots = ["User-agent: GPTBot", "Disallow: /", "Allow: /blog/"].join("\n");
    expect(blockedCrawlers(robots, "/blog/post")).toEqual([]);
    expect(blockedCrawlers(robots, "/pricing")).toEqual(["GPTBot"]);
    expect(blockedCrawlers("User-agent: GPTBot\nDisallow: /blog\nAllow: /blog", "/blog")).toEqual([]);
  });

  it("understands * and a closing $", () => {
    const robots = ["User-agent: ClaudeBot", "Disallow: /*.pdf$", "Disallow: /*/print/"].join("\n");
    expect(blockedCrawlers(robots, "/reports/2026.pdf")).toEqual(["ClaudeBot"]);
    expect(blockedCrawlers(robots, "/reports/2026.pdf.html")).toEqual([]);
    expect(blockedCrawlers(robots, "/blog/print/post")).toEqual(["ClaudeBot"]);
    expect(blockedCrawlers(robots, "/blog/post")).toEqual([]);
  });

  it("reads a pattern full of stars in the time its length takes", () => {
    const robots = `User-agent: *\nDisallow: /${"*a".repeat(250)}*b`;
    const started = Date.now();
    expect(blockedCrawlers(robots, `/${"a".repeat(1900)}`)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("groups several names over one set of rules, and starts a new group after the rules", () => {
    const groups = parseRobots(["User-agent: a", "User-agent: b", "Crawl-delay: 5", "Disallow: /x", "User-agent: c", "Allow: /"].join("\n"));
    expect(groups).toEqual([
      { agents: ["a", "b"], rules: [{ allow: false, path: "/x" }] },
      { agents: ["c"], rules: [{ allow: true, path: "/" }] },
    ]);
  });

  it("names a crawler with the engine it reads for", () => {
    expect(crawlerLabel("GPTBot")).toBe("GPTBot (ChatGPT)");
    expect(crawlerLabel("googlebot")).toBe("Googlebot (Google Search and AI Overviews)");
    expect(crawlerLabel("SomeOtherBot")).toBe("SomeOtherBot");
  });
});
