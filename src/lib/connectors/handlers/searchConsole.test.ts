import { describe, expect, it, vi } from "vitest";
import { parseManifest } from "../manifest";
import { searchConsoleManifest } from "../manifests/searchConsole";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { readLive } from "../live";
import { googleFailure, lastCompleteFrom, MAX_SITES, mergeByHost, mergePages, MERGED_NOTE, NO_TOTALS_NOTE, notFinalNote, pagePattern, searchAnalytics, siteCheck, siteLabel, sites, sitesFrom, totalsFrom } from "./searchConsole";

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

// The totals query's answer: one row with no keys, the report's headline numbers.
const TOTALS = { clicks: 40, impressions: 2000, ctr: 0.02, position: 8.4 };
const totalsAnswer = () => answer({ rows: [TOTALS], responseAggregationType: "byProperty" });

// The date probe's answer: days through 21 Nov, with 21 Nov still being collected.
const probe = (first = "2026-11-21") =>
  answer({ rows: ["2026-11-19", "2026-11-20", "2026-11-21"].map((d) => ({ keys: [d], clicks: 1, impressions: 10 })), metadata: { first_incomplete_date: first } });

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
  const body = (t: { mock: { calls: Array<[string, RequestInit]> } }, i: number) => JSON.parse(String(t.mock.calls[i]![1].body)) as Record<string, unknown>;
  const ask = (by: "day" | "page" | "topic", over: Record<string, unknown> = {}, today = "2026-11-22") => ({
    ...input(),
    query: { stream: "search_performance", period: "last_28_days" as const, by, limit: 50, ...over },
    today,
  });

  it("reads Search Console's own last 28 days: complete Pacific days ending the day before its first incomplete one, fresh days included", async () => {
    const { transport, deps: d } = deps(probe(), answer({ rows: [{ keys: ["https://example.com/"], clicks: 3, impressions: 300, ctr: 0.01, position: 6.5 }] }), totalsAnswer());
    const r = await searchAnalytics(ask("page"), d);
    expect(body(transport, 0)).toEqual({ startDate: "2026-11-13", endDate: "2026-11-22", dimensions: ["date"], type: "web", dataState: "all", rowLimit: 10 });
    // Exactly the report's request: no aggregationType, so pages aggregate by page as its Pages tab does.
    expect(body(transport, 1)).toEqual({ startDate: "2026-10-24", endDate: "2026-11-20", dimensions: ["page"], type: "web", dataState: "all", rowLimit: 1000 });
    // The headline totals: the same days and data with no dimensions, as the report's chart totals.
    expect(body(transport, 2)).toEqual({ startDate: "2026-10-24", endDate: "2026-11-20", type: "web", dataState: "all" });
    expect(r).toMatchObject({
      ok: true,
      period: { from: "2026-10-24", to: "2026-11-20", timeZone: "America/Los_Angeles", finalThrough: "2026-11-19" },
      rows: [{ page: "/", host: "example.com", searchClicks: 3, searchImpressions: 300 }],
      totals: { searchClicks: 40, searchImpressions: 2000, searchCtr: 0.02, searchPosition: 8.4 },
      notes: [notFinalNote("2026-11-20", "2026-11-20")],
      more: false,
    });
    // Google finishes a day 2 to 3 days later, and the read doesn't ask which: "may".
    expect(r.ok && r.notes[0]).toBe("Search Console's numbers for 20 Nov may not be final yet. Its own report shows them too, and they may still change a little.");
  });

  it("reads the totals row, zeros when Google lists nothing, and keeps the rows with a note when the totals fail", async () => {
    expect(totalsFrom({ rows: [TOTALS] })).toEqual({ searchClicks: 40, searchImpressions: 2000, searchCtr: 0.02, searchPosition: 8.4 });
    expect(totalsFrom({})).toEqual({ searchClicks: 0, searchImpressions: 0, searchCtr: null, searchPosition: null });
    expect(totalsFrom({ rows: "nope" })).toBeNull();
    expect(totalsFrom(null)).toBeNull();
    const { deps: d } = deps(probe(), answer({ rows: [{ keys: ["https://example.com/"], clicks: 3, impressions: 300, ctr: 0.01, position: 6.5 }] }), answer({ error: { status: "RESOURCE_EXHAUSTED" } }, 429));
    const r = await searchAnalytics(ask("page"), d);
    expect(r).toMatchObject({ ok: true, rows: [{ page: "/", searchClicks: 3 }] });
    expect(r.ok && r.totals).toBeUndefined();
    expect(r.ok && r.notes.at(-1)).toBe(NO_TOTALS_NOTE);
  });

  it("finds the last complete day from either spelling, the newest day listed, or yesterday", () => {
    const b = (first: string | null, rows: string[] = []) => ({ rows: rows.map((d) => ({ keys: [d] })), ...(first ? { metadata: { firstIncompleteDate: first } } : {}) });
    expect(lastCompleteFrom({ metadata: { first_incomplete_date: "2026-11-21" } }, "2026-11-22")).toBe("2026-11-20");
    expect(lastCompleteFrom(b("2026-11-20"), "2026-11-22")).toBe("2026-11-19");
    expect(lastCompleteFrom(b(null, ["2026-11-19", "2026-11-20"]), "2026-11-22")).toBe("2026-11-20");
    expect(lastCompleteFrom(b(null, ["2026-11-22"]), "2026-11-22")).toBe("2026-11-21");
    expect(lastCompleteFrom(b(null), "2026-11-22")).toBe("2026-11-21");
    expect(lastCompleteFrom(null, "2026-11-22")).toBe("2026-11-21");
  });

  it("works out Pacific days: at 05:00 UTC on 22 Nov it is still 21 Nov there", async () => {
    // readLive passes the day in the stream's zone; the request check refuses 22 Nov as a future day.
    const { transport, deps: d } = deps(probe("2026-11-20"), answer({ rows: [] }));
    const r = await searchAnalytics(ask("day", {}, "2026-11-21"), d);
    expect(body(transport, 0)).toMatchObject({ startDate: "2026-11-12", endDate: "2026-11-21" });
    expect(r).toMatchObject({ ok: true, period: { from: "2026-10-23", to: "2026-11-19", finalThrough: "2026-11-18" } });
  });

  it("caps explicit days at the last complete day with a dated note, and skips the probe for days long complete", async () => {
    const capped = deps(probe(), answer({ rows: [] }));
    const r = await searchAnalytics(ask("day", { period: undefined, from: "2026-11-10", to: "2026-11-22" }), capped.deps);
    expect(body(capped.transport, 1)).toMatchObject({ startDate: "2026-11-10", endDate: "2026-11-20", rowLimit: 11 });
    expect(r).toMatchObject({ ok: true, period: { from: "2026-11-10", to: "2026-11-20" } });
    expect(r.ok && r.notes[0]).toBe("The last complete day in Search Console is 20 Nov, so this read ends there.");
    const past = deps(answer({ rows: [] }), answer({}));
    const old = await searchAnalytics(ask("day", { period: undefined, from: "2026-11-01", to: "2026-11-15" }), past.deps);
    // No probe: the read and its totals only.
    expect(past.transport).toHaveBeenCalledTimes(2);
    expect(body(past.transport, 0)).toMatchObject({ startDate: "2026-11-01", endDate: "2026-11-15", dataState: "all" });
    expect(old).toEqual({
      ok: true,
      rows: [],
      notes: [],
      period: { from: "2026-11-01", to: "2026-11-15", timeZone: "America/Los_Angeles", finalThrough: "2026-11-15" },
      totals: { searchClicks: 0, searchImpressions: 0, searchCtr: null, searchPosition: null },
      more: false,
    });
    const none = await searchAnalytics(ask("day", { period: undefined, from: "2026-11-21", to: "2026-11-22" }), deps(probe()).deps);
    expect(none).toMatchObject({ ok: true, rows: [], notes: ["Search Console hasn't finished 21 and 22 Nov yet, so there is nothing to read for those days. Its last complete day is 20 Nov."] });
  });

  it("keeps hosts apart as the Pages report does: / on the bare host and on www are two rows", async () => {
    const { deps: d } = deps(
      probe(),
      answer({
        rows: [
          { keys: ["https://example.com/"], clicks: 2, impressions: 300, ctr: 0.0067, position: 6.5 },
          { keys: ["https://example.com/features/example"], clicks: 1, impressions: 100, ctr: 0.01, position: 9.5 },
          { keys: ["https://www.example.com/"], clicks: 0, impressions: 5, ctr: 0, position: 12 },
        ],
      }),
    );
    const r = await searchAnalytics(ask("page"), d);
    expect(r.ok && r.rows).toEqual([
      { page: "/", host: "example.com", searchClicks: 2, searchImpressions: 300, searchCtr: 0.0067, searchPosition: 6.5 },
      { page: "/features/example", host: "example.com", searchClicks: 1, searchImpressions: 100, searchCtr: 0.01, searchPosition: 9.5 },
      { page: "/", host: "www.example.com", searchClicks: 0, searchImpressions: 5, searchCtr: 0, searchPosition: 12 },
    ]);
  });

  it("adds together only addresses for the same host and path, says how many, and works rate and position out again", async () => {
    const { deps: d } = deps(
      probe(),
      answer({
        rows: [
          { keys: ["https://example.com/pricing?ref=a"], clicks: 6, impressions: 100, ctr: 0.06, position: 2 },
          { keys: ["https://example.com/pricing"], clicks: 2, impressions: 300, ctr: 0.0067, position: 6 },
          { keys: ["https://example.com/blog/notes#top"], clicks: 7, impressions: 70, ctr: 0.1, position: 3 },
        ],
      }),
    );
    const r = await searchAnalytics(ask("page"), d);
    expect(r.ok && r.rows).toEqual([
      { page: "/pricing", host: "example.com", searchClicks: 8, searchImpressions: 400, searchCtr: 0.02, searchPosition: 5, merged: 2 },
      { page: "/blog/notes", host: "example.com", searchClicks: 7, searchImpressions: 70, searchCtr: 0.1, searchPosition: 3 },
    ]);
    expect(r.ok && r.notes).toContain(MERGED_NOTE);
    expect(mergePages([{ page: "https://a.example/x" }, { page: "https://b.example/x" }]).map((x) => x.host)).toEqual(["a.example", "b.example"]);
  });

  it("fetches 1,000 rows whatever the limit, merges a variant far down the list, orders ties by impressions then page, and says when Google had more", async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ keys: [`https://example.com/p${String(i).padStart(4, "0")}`], clicks: i < 2 ? 5 : 0, impressions: 1000 - i, ctr: 0, position: 10 }));
    // A query string variant of the top page, at Google's row 80.
    rows[80] = { keys: ["https://example.com/p0000?utm=x"], clicks: 0, impressions: 3, ctr: 0, position: 4 };
    const { transport, deps: d } = deps(probe(), answer({ rows }));
    const r = await searchAnalytics(ask("page", { limit: 50 }), d);
    expect(body(transport, 1).rowLimit).toBe(1000);
    if (!r.ok) throw new Error("read failed");
    expect(r.more).toBe(true);
    expect(r.rows[0]).toMatchObject({ page: "/p0000", searchImpressions: 1003, merged: 2 });
    expect(r.rows[1]).toMatchObject({ page: "/p0001", searchClicks: 5 });
    // Equal clicks: more impressions first.
    expect(r.rows[2]).toMatchObject({ page: "/p0002", searchImpressions: 998 });
  });

  it("groups by search under the query key, most clicked first, ties by impressions", async () => {
    const { transport, deps: d } = deps(
      probe(),
      answer({
        rows: [
          { keys: ["growth tools"], clicks: 1, impressions: 40, ctr: 0.025, position: 11 },
          { keys: ["waitlist software"], clicks: 9, impressions: 120, ctr: 0.075, position: 4 },
          { keys: ["launch list"], clicks: 1, impressions: 90, ctr: 0.011, position: 8 },
        ],
      }),
    );
    const r = await searchAnalytics(ask("topic"), d);
    expect(r.ok && r.rows.map((x) => x.query)).toEqual(["waitlist software", "launch list", "growth tools"]);
    expect(body(transport, 1)).toMatchObject({ dimensions: ["query"], rowLimit: 1000 });
  });

  it("reads one page by day with a row per day and host, never adding hosts together, and its query string variants merged", async () => {
    const { transport, deps: d } = deps(
      probe(),
      answer({
        rows: [
          { keys: ["2026-11-02", "https://example.com/features/example"], clicks: 2, impressions: 40, ctr: 0.05, position: 4 },
          { keys: ["2026-11-01", "https://www.example.com/features/example"], clicks: 0, impressions: 6, ctr: 0, position: 11 },
          { keys: ["2026-11-01", "https://example.com/features/example?ref=a"], clicks: 1, impressions: 10, ctr: 0.1, position: 2 },
          { keys: ["2026-11-01", "https://example.com/features/example"], clicks: 1, impressions: 30, ctr: 0.0333, position: 6 },
        ],
      }),
    );
    const r = await searchAnalytics(ask("day", { page: "/features/example" }), d);
    expect(body(transport, 1)).toEqual({
      startDate: "2026-10-24",
      endDate: "2026-11-20",
      type: "web",
      dataState: "all",
      dimensionFilterGroups: [{ filters: [{ dimension: "page", operator: "includingRegex", expression: "^https?://[^/]+/features/example([?#].*)?$" }] }],
      dimensions: ["date", "page"],
      rowLimit: 1000,
    });
    // One page's rows are by host, so there are no site totals to send: no third call.
    expect(transport).toHaveBeenCalledTimes(2);
    expect(r.ok && r.rows).toEqual([
      { day: "2026-11-01", host: "example.com", searchClicks: 2, searchImpressions: 40, searchCtr: 0.05, searchPosition: 5, merged: 2 },
      { day: "2026-11-01", host: "www.example.com", searchClicks: 0, searchImpressions: 6, searchCtr: 0, searchPosition: 11 },
      { day: "2026-11-02", host: "example.com", searchClicks: 2, searchImpressions: 40, searchCtr: 0.05, searchPosition: 4 },
    ]);
    expect(r.ok && r.totals).toBeUndefined();
    expect(r.ok && r.notes).toContain(MERGED_NOTE);
    expect(pagePattern("/a.b(c)")).toBe("^https?://[^/]+/a\\.b\\(c\\)([?#].*)?$");
  });

  it("reads one page's searches by host too", async () => {
    const { transport, deps: d } = deps(
      probe(),
      answer({
        rows: [
          { keys: ["growth tools", "https://example.com/pricing"], clicks: 3, impressions: 50, ctr: 0.06, position: 4 },
          { keys: ["growth tools", "https://www.example.com/pricing"], clicks: 1, impressions: 20, ctr: 0.05, position: 7 },
        ],
      }),
    );
    const r = await searchAnalytics(ask("topic", { page: "/pricing" }), d);
    expect(body(transport, 1)).toMatchObject({ dimensions: ["query", "page"], rowLimit: 1000 });
    expect(r.ok && r.rows).toEqual([
      { query: "growth tools", host: "example.com", searchClicks: 3, searchImpressions: 50, searchCtr: 0.06, searchPosition: 4 },
      { query: "growth tools", host: "www.example.com", searchClicks: 1, searchImpressions: 20, searchCtr: 0.05, searchPosition: 7 },
    ]);
    expect(mergeByHost([{ query: "a", address: "https://x.example/p" }, { query: "b", address: "https://x.example/p" }], "query")).toHaveLength(2);
  });

  it("keeps a by day read's days in order, and reads final numbers only when asked to settle", async () => {
    const days = deps(probe(), answer({ rows: [{ keys: ["2026-11-02"], clicks: 4, impressions: 90, ctr: 0.0444, position: 7.2 }, { keys: ["2026-11-01"], clicks: 3, impressions: 80, ctr: 0.0375, position: 8.1 }] }));
    const r = await searchAnalytics(ask("day"), days.deps);
    expect(r.ok && r.rows.map((x) => x.day)).toEqual(["2026-11-01", "2026-11-02"]);
    const settled = deps(answer({ rows: [] }));
    const s = await searchAnalytics(ask("day", { settledOnly: true }), settled.deps);
    expect(settled.transport).toHaveBeenCalledTimes(1);
    expect(body(settled.transport, 0)).toMatchObject({ startDate: "2026-10-23", endDate: "2026-11-19", dataState: "final" });
    expect(s).toMatchObject({ ok: true, notes: [], period: { to: "2026-11-19", finalThrough: "2026-11-19" } });
  });

  it("says when yesterday isn't finished and reads Search Console's last complete day", async () => {
    const { transport, deps: d } = deps(probe("2026-11-20"), answer({ rows: [] }));
    const r = await searchAnalytics(ask("day", { period: "yesterday" }), d);
    expect(body(transport, 1)).toMatchObject({ startDate: "2026-11-19", endDate: "2026-11-19" });
    expect(r.ok && r.notes).toContain("Search Console hasn't finished 20 and 21 Nov yet, so there is nothing to read for those days. Its last complete day is 19 Nov.");
  });

  it("refuses another stream, no site picked, and a bad answer, calling nobody for the first two", async () => {
    const { transport, deps: d } = deps(probe(), answer({ rows: "nope" }));
    expect(await searchAnalytics(ask("day", { stream: "zone_daily" }), d)).toMatchObject({ ok: false, code: "query_refused" });
    expect(await searchAnalytics({ ...ask("day"), account: "" }, d)).toMatchObject({ ok: false, code: "account_needed" });
    expect(transport).not.toHaveBeenCalled();
    expect(await searchAnalytics(ask("day"), d)).toMatchObject({ ok: false, code: "bad_response" });
    expect(await searchAnalytics(ask("day"), deps(probe(), answer({})).deps)).toMatchObject({ ok: true, rows: [] });
    expect(await searchAnalytics(ask("day"), deps(answer({ error: { status: "PERMISSION_DENIED" } }, 403)).deps)).toMatchObject({ ok: false, code: "account_refused" });
  });

  it("sends the token only to Search Console, and refuses a redirect", async () => {
    const { deps: d } = deps(new Response(null, { status: 302, headers: { location: "https://elsewhere.example.test/" } }));
    expect(await searchAnalytics(ask("day"), d)).toMatchObject({ ok: false, code: "redirect_refused" });
  });

  it("dates its notes in house style", () => {
    for (const t of [notFinalNote("2026-11-19", "2026-11-21"), MERGED_NOTE, NO_TOTALS_NOTE]) {
      expect(dashesIn(t), t).toEqual([]);
      expect(aiTellsIn(t), t).toEqual([]);
    }
  });
});

describe("Search Console through readLive", () => {
  it("answers the agent's last 28 days with the period in words, the host, the report's totals and more", async () => {
    const { deps: d } = deps(probe(), answer({ rows: [{ keys: ["https://example.com/"], clicks: 3, impressions: 300, ctr: 0.01, position: 6.5 }] }), totalsAnswer());
    const r = await readLive({ ...input(), query: { stream: "search_performance", period: "last_28_days", by: "page", limit: 50 } }, { ...d, now: new Date("2026-11-22T18:00:00Z") });
    if (!r.ok) throw new Error("read failed");
    expect(r.answer.period).toEqual({ from: "2026-10-24", to: "2026-11-20", timeZone: "America/Los_Angeles", finalThrough: "2026-11-19", words: "24 Oct to 20 Nov 2026, Pacific time" });
    expect(r.answer.rows).toEqual([{ page: "/", host: "example.com", searchClicks: 3, searchImpressions: 300, searchCtr: 0.01, searchPosition: 6.5 }]);
    expect(r.answer).toMatchObject({
      more: false,
      totals: { searchClicks: 40, searchImpressions: 2000, searchCtr: 0.02, searchPosition: 8.4 },
      connectorId: "search-console",
      connector: "Google Search Console",
    });
    expect(Object.keys(r.answer.meanings)).toEqual(["searchClicks", "searchImpressions", "searchCtr", "searchPosition"]);
  });

  it("gives the hook Pacific today: at 05:00 UTC on 22 Nov it is still 21 Nov there, never the UTC day", async () => {
    const { transport, deps: d } = deps(probe("2026-11-20"), answer({ rows: [] }), totalsAnswer());
    const r = await readLive({ ...input(), query: { stream: "search_performance", period: "last_28_days", by: "day", limit: 50 } }, { ...d, now: new Date("2026-11-22T05:00:00Z") });
    if (!r.ok) throw new Error("read failed");
    const probeBody = JSON.parse(String(transport.mock.calls[0]![1].body)) as Record<string, unknown>;
    expect(probeBody).toMatchObject({ startDate: "2026-11-12", endDate: "2026-11-21" });
    // The day before first_incomplete_date (20 Nov).
    expect(r.answer.period).toMatchObject({ from: "2026-10-23", to: "2026-11-19", words: "23 Oct to 19 Nov 2026, Pacific time" });
  });

  it("keeps a merged count on its row, explained by its meaning", async () => {
    const { deps: d } = deps(
      probe(),
      answer({ rows: [{ keys: ["https://example.com/?ref=a"], clicks: 1, impressions: 4, ctr: 0.25, position: 3 }, { keys: ["https://example.com/"], clicks: 0, impressions: 4, ctr: 0, position: 5 }] }),
    );
    const r = await readLive({ ...input(), query: { stream: "search_performance", period: "last_7_days", by: "page", limit: 50 } }, { ...d, now: new Date("2026-11-22T18:00:00Z") });
    if (!r.ok) throw new Error("read failed");
    expect(r.answer.rows).toEqual([{ page: "/", host: "example.com", searchClicks: 1, searchImpressions: 8, searchCtr: 0.125, searchPosition: 4, merged: 2 }]);
    expect(r.answer.meanings.merged?.name).toBe("Addresses added together");
    expect(r.answer.notes).toContain(MERGED_NOTE);
  });
});
