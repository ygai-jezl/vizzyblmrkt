import { describe, expect, it, vi } from "vitest";
import { parseManifest } from "../manifest";
import { searchConsoleManifest } from "../manifests/searchConsole";
import { googleFailure, MAX_SITES, NOT_FINAL_NOTE, searchAnalytics, siteCheck, siteLabel, sites, sitesFrom } from "./searchConsole";

// Google is never called: the transport is a stub that answers like the Search Console API.
const manifest = parseManifest(searchConsoleManifest);
const TOKEN = "made-up-google-access";
const NOW = new Date("2026-11-21T10:00:00.000Z");
const health = { state: "ok" as const, lastOkAt: null, lastCheckedAt: null, lastErrorCode: null, failures: 0, pausedUntil: null };
const input = (account = "sc-domain:example.com") => ({ manifest, connection: { id: "dcn_aaaaaaaaaaaaaaaaaaaa", tenantId: "ten_a", pausedAt: null, health }, account, token: TOKEN });

const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function deps(...responses: Response[]) {
  const transport = vi.fn(async (_url: string, _init: RequestInit) => responses.shift() ?? answer({}, 500));
  return { transport, deps: { transport, limit: async () => false, log: () => {}, now: NOW } };
}
const SITES = {
  siteEntry: [
    { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
    { siteUrl: "https://blog.example.com/", permissionLevel: "siteRestrictedUser" },
    { siteUrl: "https://someone-else.example.test/", permissionLevel: "siteUnverifiedUser" },
  ],
};
const live = (by: "day" | "page" | "topic", over: Record<string, unknown> = {}) => ({
  ...input(),
  query: { stream: "search_performance", from: "2026-11-01", to: "2026-11-15", by, limit: 100, ...over },
  today: "2026-11-21",
});

describe("Search Console sites", () => {
  it("lists verified sites for the picker, unverified ones left out, with the access in words", async () => {
    const { transport, deps: d } = deps(answer(SITES));
    expect(await sites(input(""), d)).toEqual({
      ok: true,
      accounts: [
        { id: "sc-domain:example.com", label: "example.com (whole domain)", detail: "Owner" },
        { id: "https://blog.example.com/", label: "https://blog.example.com/", detail: "Restricted user" },
      ],
      more: false,
    });
    expect(transport.mock.calls[0]![0]).toBe("https://searchconsole.googleapis.com/webmasters/v3/sites");
    expect((transport.mock.calls[0]![1].headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("caps the picker and says there were more", async () => {
    const many = { siteEntry: Array.from({ length: MAX_SITES + 5 }, (_, i) => ({ siteUrl: `https://s${String(i).padStart(3, "0")}.example.com/`, permissionLevel: "siteFullUser" })) };
    const r = await sites(input(""), deps(answer(many)).deps);
    expect(r).toMatchObject({ ok: true, more: true });
    expect(r.ok && r.accounts.length).toBe(MAX_SITES);
  });

  it("reads Google's empty answer as no sites, and anything else odd as a bad response", () => {
    expect(sitesFrom({})).toEqual([]);
    expect(sitesFrom({ siteEntry: "nope" })).toBeNull();
    expect(sitesFrom(null)).toBeNull();
    expect(siteLabel("sc-domain:example.com")).toBe("example.com (whole domain)");
  });

  it("checks a sign in with no site picked by listing, and a picked site by finding it verified", async () => {
    expect(await siteCheck(input(""), deps(answer({})).deps)).toEqual({ ok: true });
    expect(await siteCheck(input(), deps(answer(SITES)).deps)).toEqual({ ok: true });
    expect(await siteCheck(input("https://someone-else.example.test/"), deps(answer(SITES)).deps)).toEqual({ ok: false, code: "account_refused", retryAfterSec: null });
    expect(await siteCheck(input("https://gone.example.com/"), deps(answer(SITES)).deps)).toMatchObject({ ok: false, code: "account_refused" });
  });

  it("tells this copy's setup, a rate limit, an ended sign in and a site it can't read apart", () => {
    const failed = (status: number, body: unknown) => googleFailure({ ok: false, code: "token_refused", status, body, retryAfterSec: null });
    expect(failed(403, { error: { status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] } }).code).toBe("signin_unconfigured");
    expect(failed(403, { error: { errors: [{ reason: "accessNotConfigured" }] } }).code).toBe("signin_unconfigured");
    expect(failed(403, { error: { errors: [{ reason: "quotaExceeded" }] } }).code).toBe("rate_limited");
    expect(failed(401, { error: { status: "UNAUTHENTICATED" } }).code).toBe("signin_refused");
    expect(failed(403, { error: { message: "User does not have sufficient permission for site" } }).code).toBe("account_refused");
  });
});

describe("Search Console searchAnalytics", () => {
  it("reads a site by day, finalized web results only, with the site in the address and nothing else from outside in the query", async () => {
    const { transport, deps: d } = deps(
      answer({
        rows: [
          { keys: ["2026-11-02"], clicks: 4, impressions: 90, ctr: 0.0444, position: 7.2 },
          { keys: ["2026-11-01"], clicks: 3, impressions: 80, ctr: 0.0375, position: 8.1 },
        ],
      }),
    );
    const r = await searchAnalytics(live("day"), d);
    expect(r).toEqual({
      ok: true,
      rows: [
        { day: "2026-11-01", searchClicks: 3, searchImpressions: 80, searchCtr: 0.0375, searchPosition: 8.1 },
        { day: "2026-11-02", searchClicks: 4, searchImpressions: 90, searchCtr: 0.0444, searchPosition: 7.2 },
      ],
      notes: [],
    });
    expect(transport.mock.calls[0]![0]).toBe("https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query");
    expect(JSON.parse(String(transport.mock.calls[0]![1].body))).toEqual({
      startDate: "2026-11-01",
      endDate: "2026-11-15",
      dimensions: ["date"],
      type: "web",
      dataState: "final",
      rowLimit: 100,
    });
  });

  it("adds pages with the same path together, without their query strings", async () => {
    const { deps: d } = deps(
      answer({
        rows: [
          { keys: ["https://example.com/pricing?ref=a"], clicks: 6, impressions: 100, ctr: 0.06, position: 2 },
          { keys: ["https://www.example.com/pricing"], clicks: 2, impressions: 300, ctr: 0.0067, position: 6 },
          { keys: ["https://example.com/blog/notes#top"], clicks: 7, impressions: 70, ctr: 0.1, position: 3 },
        ],
      }),
    );
    const r = await searchAnalytics(live("page"), d);
    expect(r.ok && r.rows).toEqual([
      { page: "/pricing", searchClicks: 8, searchImpressions: 400, searchCtr: 0.02, searchPosition: 5 },
      { page: "/blog/notes", searchClicks: 7, searchImpressions: 70, searchCtr: 0.1, searchPosition: 3 },
    ]);
  });

  it("groups by search under the query key, most clicked first, and says when the days aren't final", async () => {
    const { transport, deps: d } = deps(
      answer({
        rows: [
          { keys: ["growth tools"], clicks: 1, impressions: 40, ctr: 0.025, position: 11 },
          { keys: ["waitlist software"], clicks: 9, impressions: 120, ctr: 0.075, position: 4 },
        ],
      }),
    );
    const r = await searchAnalytics(live("topic", { to: "2026-11-20", limit: 1 }), d);
    expect(r).toEqual({ ok: true, rows: [{ query: "waitlist software", searchClicks: 9, searchImpressions: 120, searchCtr: 0.075, searchPosition: 4 }], notes: [NOT_FINAL_NOTE] });
    expect(JSON.parse(String(transport.mock.calls[0]![1].body))).toMatchObject({ dimensions: ["query"], rowLimit: 1 });
  });

  it("refuses another stream, no site picked, and a bad answer, calling nobody for the first two", async () => {
    const { transport, deps: d } = deps(answer({ rows: "nope" }));
    expect(await searchAnalytics(live("day", { stream: "zone_daily" }), d)).toMatchObject({ ok: false, code: "query_refused" });
    expect(await searchAnalytics({ ...live("day"), account: "" }, d)).toMatchObject({ ok: false, code: "account_needed" });
    expect(transport).not.toHaveBeenCalled();
    expect(await searchAnalytics(live("day"), d)).toMatchObject({ ok: false, code: "bad_response" });
    expect(await searchAnalytics(live("day"), deps(answer({})).deps)).toEqual({ ok: true, rows: [], notes: [] });
  });

  it("sends the token only to Search Console, and refuses a redirect", async () => {
    const { deps: d } = deps(new Response(null, { status: 302, headers: { location: "https://elsewhere.example.test/" } }));
    expect(await searchAnalytics(live("day"), d)).toMatchObject({ ok: false, code: "redirect_refused" });
  });
});
