import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { COMPETITOR_LIMITS } from "@/lib/types/competitor";
import { fetchHtml, fetchSitemapFile, mayFetch, robotsFor, type FetchDeps } from "./fetch";

const answer = (body: string | Buffer, status = 200, type = "application/xml"): FetchDeps =>
  ({ fetch: async () => new Response(body as unknown as BodyInit, { status, headers: { "content-type": type } }) }) as unknown as FetchDeps;

describe("fetching for Competitors", () => {
  it("reads a gzipped sitemap whatever the server calls it", async () => {
    const got = await fetchSitemapFile("https://a.example/s.xml.gz", answer(gzipSync("<urlset><url><loc>https://a.example/x</loc></url></urlset>"), 200, "application/octet-stream"));
    expect(got).toMatchObject({ ok: true, truncated: false });
    expect(got.ok && got.text).toContain("<loc>https://a.example/x</loc>");
  });

  it("says a file was cut when it is bigger than the cap, plain or unzipped", async () => {
    const big = "x".repeat(COMPETITOR_LIMITS.MAX_SITEMAP_BYTES + 10);
    expect(await fetchSitemapFile("https://a.example/s.xml", answer(big))).toMatchObject({ ok: true, truncated: true });
    expect(await fetchSitemapFile("https://a.example/s.xml.gz", answer(gzipSync(big)))).toMatchObject({ ok: true, truncated: true, text: "" });
  });

  it("turns statuses into reasons, and refuses a page that isn't HTML", async () => {
    expect(await fetchSitemapFile("https://a.example/s.xml", answer("", 404))).toEqual({ ok: false, reason: "not_found" });
    expect(await fetchSitemapFile("https://a.example/s.xml", answer("", 403))).toEqual({ ok: false, reason: "refused" });
    expect(await fetchSitemapFile("https://a.example/s.xml", answer("", 500))).toEqual({ ok: false, reason: "failed" });
    expect(await fetchHtml("https://a.example/news", answer("{}", 200, "application/json"))).toEqual({ ok: false, reason: "failed" });
    const throws = { fetch: async () => Promise.reject(new Error("host_blocked")) } as unknown as FetchDeps;
    expect(await fetchHtml("https://a.example/news", throws)).toEqual({ ok: false, reason: "failed" });
  });

  it("reads robots.txt: no file means no rules, a site we couldn't ask means keep out", async () => {
    const rules = await robotsFor("https://a.example", answer("User-agent: yougrowbot\nDisallow: /news/private\n", 200, "text/plain"));
    expect(mayFetch(rules, "https://a.example/news/a")).toBe(true);
    expect(mayFetch(rules, "https://a.example/news/private/x")).toBe(false);
    expect(mayFetch(await robotsFor("https://a.example", answer("", 404)), "https://a.example/news")).toBe(true);
    expect(mayFetch(await robotsFor("https://a.example", answer("<!doctype html><p>hi", 200, "text/html")), "https://a.example/news")).toBe(true);
    expect(mayFetch(await robotsFor("https://a.example", answer("", 503)), "https://a.example/news")).toBe(false);
    const everyone = await robotsFor("https://a.example", answer("User-agent: *\nDisallow: /\n", 200, "text/plain"));
    expect(mayFetch(everyone, "https://a.example/news")).toBe(false);
  });
});
