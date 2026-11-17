import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPETITOR_LIMITS } from "@/lib/types/competitor";
import { fetchHtml, fetchSitemapFile, isChallenge, mayFetch, robotsFor, type FetchDeps } from "./fetch";

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
    expect(await fetchSitemapFile("https://a.example/s.xml", answer("", 403))).toEqual({ ok: false, reason: "turned_away" });
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

  describe("a bot screen in front of the site", () => {
    afterEach(() => vi.restoreAllMocks());
    // SiteGround's challenge: a small page that sends the browser to its captcha.
    const sgcaptcha = `<html><head><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=%2Fsitemap.xml&y=ipc:1"></head></html>`;

    it("is turned away, whether it refuses or answers with a challenge page where the file should be", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      expect(await fetchSitemapFile("https://a.example/sitemap.xml", answer(sgcaptcha, 202, "text/html"))).toEqual({ ok: false, reason: "turned_away" });
      expect(await fetchHtml("https://a.example/blog", answer(sgcaptcha, 200, "text/html"))).toEqual({ ok: false, reason: "turned_away" });
      const cloudflare = "<!DOCTYPE html><html><head><title>Just a moment...</title></head><body></body></html>";
      expect(await fetchSitemapFile("https://a.example/sitemap.xml", answer(cloudflare, 503, "text/html"))).toEqual({ ok: false, reason: "turned_away" });
      // A 503 that is only a 503 is a failure, not a refusal.
      expect(await fetchSitemapFile("https://a.example/sitemap.xml", answer("<html><body>Down for maintenance</body></html>", 503, "text/html"))).toEqual({ ok: false, reason: "failed" });
      const robots = await robotsFor("https://a.example", answer(sgcaptcha, 202, "text/html"));
      expect(robots).toMatchObject({ reachable: false, turnedAway: true });
      expect(mayFetch(robots, "https://a.example/blog")).toBe(false);
    });

    it("doesn't mistake an ordinary page carrying a screen's script for a challenge", async () => {
      const script = `<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>`;
      const page = `<!doctype html><html><head>${script}</head><body>${"<p>A post about whitening.</p>".repeat(2000)}</body></html>`;
      expect(await fetchHtml("https://a.example/blog", answer(page, 200, "text/html"))).toMatchObject({ ok: true });
      // The same script on a page of a few bytes is the challenge itself.
      expect(isChallenge("https://a.example/blog", `<html><head>${script}</head></html>`, { bytes: 200 })).toBe(true);
      // A contact form's captcha is not a screen.
      expect(isChallenge("https://a.example/contact", `<div class="g-recaptcha"></div>`, { bytes: 200 })).toBe(false);
      // A web page where robots.txt should be (a site that answers every address) says so.
      expect(await robotsFor("https://a.example", answer("<!doctype html><p>Home</p>", 200, "text/html"))).toMatchObject({ reachable: true, turnedAway: false, html: true });
    });

    it("says why a fetch failed by host only, and stays quiet about files that aren't there", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await fetchSitemapFile("https://a.example/private/person@example.com/sitemap.xml", answer("", 403));
      await fetchSitemapFile("https://a.example/sitemap.xml", answer("", 404));
      await fetchSitemapFile("https://a.example/sitemap.xml", answer(sgcaptcha, 202, "text/html"));
      const throws = { fetch: async () => Promise.reject(new Error("host_blocked")) } as unknown as FetchDeps;
      await fetchHtml("https://a.example/news?who=someone", throws);
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines).toEqual([
        "[competitors] fetch a.example answered 403 (turned away)",
        "[competitors] fetch a.example answered 202 with a challenge page (turned away)",
        "[competitors] fetch a.example answered host_blocked",
      ]);
      expect(lines.join(" ")).not.toMatch(/person|private|someone|sitemap/);
    });
  });
});
