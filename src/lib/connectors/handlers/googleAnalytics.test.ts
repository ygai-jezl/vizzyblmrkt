import { describe, expect, it, vi } from "vitest";
import { parseManifest } from "../manifest";
import { ga4Manifest } from "../manifests/ga4";
import { readLive } from "../live";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { MAX_PROPERTIES, notFinalNote, OTHER_NOTE, properties, propertyCheck, QUOTA_NOTE, relativeRange, runReport, SAMPLED_NOTE, showingNote, summariesFrom, THRESHOLD_NOTE } from "./googleAnalytics";

// Google is never called: the transport is a stub that answers like the Analytics Admin and Data
// APIs. Made-up properties and pages only.
const manifest = parseManifest(ga4Manifest);
const TOKEN = "made-up-google-access";
const NOW = new Date("2026-11-21T10:00:00.000Z");
const health = { state: "ok" as const, lastOkAt: null, lastCheckedAt: null, lastErrorCode: null, failures: 0, pausedUntil: null };
const input = (account = "properties/1000") => ({ manifest, connection: { id: "dcn_aaaaaaaaaaaaaaaaaaaa", tenantId: "ten_a", pausedAt: null, health }, account, token: TOKEN });
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function deps(...responses: Response[]) {
  const transport = vi.fn(async (_url: string, _init: RequestInit) => responses.shift() ?? answer({}, 500));
  return { transport, deps: { transport, limit: async () => false, log: () => {}, now: NOW } };
}

const SUMMARIES = {
  accountSummaries: [
    {
      name: "accountSummaries/100",
      account: "accounts/100",
      displayName: "Example Co",
      propertySummaries: [
        { property: "properties/1000", displayName: "Example site", propertyType: "PROPERTY_TYPE_ORDINARY", parent: "accounts/100" },
        { property: "properties/1001", displayName: "All brands", propertyType: "PROPERTY_TYPE_ROLLUP", parent: "accounts/100" },
        { property: "not-a-property", displayName: "Odd" },
      ],
    },
    { name: "accountSummaries/200", account: "accounts/200", displayName: "Empty account" },
  ],
};

const live = (by: "day" | "page" | "landing", over: Record<string, unknown> = {}) => ({
  ...input(),
  query: { stream: "site_traffic", from: "2026-11-01", to: "2026-11-15", by, limit: 100, ...over },
  today: "2026-11-21",
});
const header = [{ name: "sessions" }, { name: "activeUsers" }, { name: "screenPageViews" }, { name: "keyEvents" }];
const values = (...n: number[]) => n.map((v) => ({ value: String(v) }));

describe("Google Analytics properties", () => {
  it("lists properties for the picker with their account and type, from accountSummaries", async () => {
    const { transport, deps: d } = deps(answer(SUMMARIES));
    expect(await properties(input(""), d)).toEqual({
      ok: true,
      accounts: [
        { id: "properties/1001", label: "All brands", detail: "Example Co, roll up property" },
        { id: "properties/1000", label: "Example site", detail: "Example Co" },
      ],
      more: false,
    });
    expect(transport.mock.calls[0]![0]).toBe("https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200");
    expect((transport.mock.calls[0]![1].headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("reads the next pages, stops at the cap and says there were more", async () => {
    const page = (i: number, next?: string) => ({
      accountSummaries: [{ displayName: `Account ${i}`, propertySummaries: Array.from({ length: 80 }, (_, j) => ({ property: `properties/${i * 1000 + j}`, displayName: `Site ${i}-${j}` })) }],
      ...(next ? { nextPageToken: next } : {}),
    });
    const { transport, deps: d } = deps(answer(page(1, "p2")), answer(page(2, "p3")), answer(page(3, "p4")));
    const r = await properties(input(""), d);
    expect(r).toMatchObject({ ok: true, more: true });
    expect(r.ok && r.accounts.length).toBe(MAX_PROPERTIES);
    expect(transport).toHaveBeenCalledTimes(3);
    expect(transport.mock.calls[1]![0]).toContain("&pageToken=p2");
  });

  it("checks a token with no property picked, and a picked property by finding it", async () => {
    expect(await propertyCheck(input(""), deps(answer({})).deps)).toEqual({ ok: true });
    expect(await propertyCheck(input("properties/1000"), deps(answer(SUMMARIES)).deps)).toEqual({ ok: true });
    expect(await propertyCheck(input("properties/9999"), deps(answer(SUMMARIES)).deps)).toMatchObject({ ok: false, code: "account_refused" });
    expect(await propertyCheck(input(), deps(answer({ error: { status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] } }, 403)).deps)).toMatchObject({ code: "signin_unconfigured" });
  });

  it("reads Google's empty answer as no properties, and anything else odd as a bad response", () => {
    expect(summariesFrom({})).toEqual({ properties: [], next: "" });
    expect(summariesFrom({ accountSummaries: "nope" })).toBeNull();
    expect(summariesFrom(null)).toBeNull();
  });
});

describe("Google Analytics runReport", () => {
  const sent = (t: { mock: { calls: Array<[string, RequestInit]> } }, i = 0) => JSON.parse(String(t.mock.calls[i]![1].body)) as Record<string, unknown>;
  const LONDON = { timeZone: "Europe/London" };

  it("reads a property by day with every metric, empty days kept, totals and returnPropertyQuota, the property in the address", async () => {
    const { transport, deps: d } = deps(
      answer({
        dimensionHeaders: [{ name: "date" }],
        metricHeaders: header,
        rows: [
          { dimensionValues: [{ value: "20261102" }], metricValues: values(12, 10, 40, 2) },
          { dimensionValues: [{ value: "20261101" }], metricValues: values(9, 8, 30, 1) },
        ],
        totals: [{ dimensionValues: [{ value: "RESERVED_TOTAL" }], metricValues: values(21, 15, 70, 3) }],
        rowCount: 2,
        metadata: LONDON,
        propertyQuota: { tokensPerDay: { consumed: 3, remaining: 199_000 }, tokensPerHour: { consumed: 3, remaining: 39_000 } },
      }),
    );
    expect(await runReport(live("day", { from: "2026-11-01", to: "2026-11-02" }), d)).toEqual({
      ok: true,
      rows: [
        { day: "2026-11-01", ga4Sessions: 9, ga4ActiveUsers: 8, ga4Views: 30, ga4KeyEvents: 1 },
        { day: "2026-11-02", ga4Sessions: 12, ga4ActiveUsers: 10, ga4Views: 40, ga4KeyEvents: 2 },
      ],
      notes: [],
      period: { from: "2026-11-01", to: "2026-11-02", timeZone: "Europe/London", finalThrough: "2026-11-02" },
      totals: { ga4Sessions: 21, ga4ActiveUsers: 15, ga4Views: 70, ga4KeyEvents: 3 },
      more: false,
    });
    expect(transport.mock.calls[0]![0]).toBe("https://analyticsdata.googleapis.com/v1beta/properties/1000:runReport");
    expect(sent(transport)).toEqual({
      dateRanges: [{ startDate: "2026-11-01", endDate: "2026-11-02" }],
      dimensions: [{ name: "date" }],
      metrics: [{ name: "sessions" }, { name: "activeUsers" }, { name: "screenPageViews" }, { name: "keyEvents" }],
      orderBys: [{ dimension: { dimensionName: "date" } }],
      limit: 2,
      metricAggregations: ["TOTAL"],
      keepEmptyRows: true,
      returnPropertyQuota: true,
    });
  });

  it("sends a named period as Google's relative dates and reports the days in the property's own zone", async () => {
    const { transport, deps: d } = deps(answer({ metricHeaders: header, rows: [], metadata: { timeZone: "America/Los_Angeles" } }));
    // 03:00 UTC on 22 Nov is still 21 Nov in Pacific time, so yesterday there is 20 Nov.
    const r = await runReport(live("day", { from: undefined, to: undefined, period: "last_28_days" }), { ...d, now: new Date("2026-11-22T03:00:00Z") });
    expect(sent(transport)).toMatchObject({ dateRanges: [{ startDate: "28daysAgo", endDate: "yesterday" }], limit: 28 });
    expect(r).toMatchObject({ ok: true, period: { from: "2026-10-24", to: "2026-11-20", timeZone: "America/Los_Angeles", finalThrough: "2026-11-19" } });
    expect(r.ok && r.notes).toEqual([notFinalNote("2026-11-20", "2026-11-20")]);
    expect(r.ok && r.notes[0]).toBe("Google Analytics can take a day or two to finish a day's numbers, so 20 Nov may be low.");
    expect(relativeRange("yesterday")).toEqual({ startDate: "yesterday", endDate: "yesterday" });
    expect(relativeRange("last_7_days")).toEqual({ startDate: "7daysAgo", endDate: "yesterday" });
  });

  it("groups pages as Pages and screens: unifiedPagePathScreen with views, active users and key events, most viewed first", async () => {
    const { transport, deps: d } = deps(
      answer({
        metricHeaders: [{ name: "screenPageViews" }, { name: "activeUsers" }, { name: "keyEvents" }],
        rows: [
          { dimensionValues: [{ value: "/blog/notes" }], metricValues: values(9, 5, 0) },
          { dimensionValues: [{ value: "/pricing" }], metricValues: values(20, 6, 3) },
          { dimensionValues: [{ value: "(other)" }], metricValues: values(90, 40, 1) },
          { dimensionValues: [{ value: "(not set)" }], metricValues: values(1, 1, 0) },
        ],
        totals: [{ metricValues: values(120, 48, 4) }],
        rowCount: 212,
        metadata: { ...LONDON, dataLossFromOtherRow: true },
      }),
    );
    const r = await runReport(live("page", { limit: 4 }), d);
    expect(r).toMatchObject({
      ok: true,
      rows: [
        { page: "/pricing", ga4Views: 20, ga4ActiveUsers: 6, ga4KeyEvents: 3 },
        { page: "/blog/notes", ga4Views: 9, ga4ActiveUsers: 5, ga4KeyEvents: 0 },
      ],
      totals: { ga4Views: 120, ga4ActiveUsers: 48, ga4KeyEvents: 4 },
      more: true,
    });
    expect(r.ok && r.notes).toEqual([OTHER_NOTE, showingNote("page", 2, 212)]);
    expect(showingNote("page", 50, 212)).toBe("Google Analytics lists 212 pages and screens for these days; this shows the top 50 by views.");
    expect(sent(transport)).toMatchObject({
      dimensions: [{ name: "unifiedPagePathScreen" }],
      metrics: [{ name: "screenPageViews" }, { name: "activeUsers" }, { name: "keyEvents" }],
      orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
      limit: 4,
      keepEmptyRows: false,
    });
  });

  it("groups landing pages as the Landing page report: landingPage with sessions, leaving out (not set)", async () => {
    const { transport, deps: d } = deps(
      answer({
        metricHeaders: [{ name: "sessions" }, { name: "activeUsers" }, { name: "keyEvents" }],
        rows: [{ dimensionValues: [{ value: "/" }], metricValues: values(40, 30, 2) }],
        totals: [{ metricValues: values(40, 30, 2) }],
        rowCount: 1,
        metadata: LONDON,
      }),
    );
    const r = await runReport(live("landing"), d);
    expect(r).toMatchObject({ ok: true, rows: [{ landing: "/", ga4Sessions: 40, ga4ActiveUsers: 30, ga4KeyEvents: 2 }], more: false });
    expect(sent(transport)).toMatchObject({
      dimensions: [{ name: "landingPage" }],
      metrics: [{ name: "sessions" }, { name: "activeUsers" }, { name: "keyEvents" }],
      dimensionFilter: { notExpression: { filter: { fieldName: "landingPage", stringFilter: { matchType: "EXACT", value: "(not set)" } } } },
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    });
  });

  it("filters to one page exactly, beside the (not set) rule for landing pages", async () => {
    const page = deps(answer({ metricHeaders: header, rows: [], metadata: LONDON }));
    await runReport(live("day", { page: "/pricing" }), page.deps);
    expect(sent(page.transport).dimensionFilter).toEqual({ filter: { fieldName: "unifiedPagePathScreen", stringFilter: { matchType: "EXACT", value: "/pricing" } } });
    const landing = deps(answer({ metricHeaders: header, rows: [], metadata: LONDON }));
    await runReport(live("landing", { page: "/pricing" }), landing.deps);
    expect(sent(landing.transport).dimensionFilter).toEqual({
      andGroup: {
        expressions: [
          { notExpression: { filter: { fieldName: "landingPage", stringFilter: { matchType: "EXACT", value: "(not set)" } } } },
          { filter: { fieldName: "landingPage", stringFilter: { matchType: "EXACT", value: "/pricing" } } },
        ],
      },
    });
  });

  it("asks for every day of a long read, so readLive keeps the latest days when it cuts", async () => {
    const days = Array.from({ length: 60 }, (_, i) => new Date(Date.UTC(2026, 8, 20 + i)).toISOString().slice(0, 10));
    const { transport, deps: d } = deps(
      answer({ metricHeaders: header, rows: days.map((day) => ({ dimensionValues: [{ value: day.replace(/-/g, "") }], metricValues: values(1, 1, 1, 0) })), rowCount: 60, metadata: LONDON }),
    );
    const r = await readLive({ ...input(), query: { stream: "site_traffic", from: days[0]!, to: days[59]!, by: "day", limit: 50 } }, d);
    expect(sent(transport).limit).toBe(60);
    if (!r.ok) throw new Error("read failed");
    expect(r.answer.rows).toHaveLength(50);
    expect(r.answer.rows.at(-1)!.day).toBe(days[59]);
    expect(r.answer.rows[0]!.day).toBe(days[10]);
    expect(r.answer.more).toBe(true);
  });

  it("reads again ending yesterday in the property's zone when the last day asked isn't over there", async () => {
    // 10:00 UTC on 21 Nov is 21 Nov in London, so 21 Nov isn't over; the second read ends on 20 Nov.
    const { transport, deps: d } = deps(answer({ metricHeaders: header, rows: [], metadata: LONDON }), answer({ metricHeaders: header, rows: [], metadata: LONDON }));
    const r = await runReport(live("day", { from: "2026-11-15", to: "2026-11-21" }), d);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(sent(transport, 1).dateRanges).toEqual([{ startDate: "2026-11-15", endDate: "2026-11-20" }]);
    expect(r).toMatchObject({ ok: true, period: { from: "2026-11-15", to: "2026-11-20", timeZone: "Europe/London" } });
    expect(r.ok && r.notes[0]).toBe("The last complete day in Google Analytics is 20 Nov, so this read ends there.");
  });

  it("matches metrics by Google's header names, not their order", async () => {
    const shuffled = [{ name: "keyEvents" }, { name: "screenPageViews" }, { name: "activeUsers" }, { name: "sessions" }];
    const { deps: d } = deps(answer({ metricHeaders: shuffled, rows: [{ dimensionValues: [{ value: "20261101" }], metricValues: values(1, 30, 8, 9) }], metadata: LONDON }));
    const r = await runReport(live("day"), d);
    expect(r.ok && r.rows[0]).toEqual({ day: "2026-11-01", ga4Sessions: 9, ga4ActiveUsers: 8, ga4Views: 30, ga4KeyEvents: 1 });
  });

  it("notes thresholds, sampling, a property low on tokens and the days not yet final, dated", async () => {
    const { deps: d } = deps(
      answer({
        metricHeaders: header,
        rows: [],
        metadata: { ...LONDON, subjectToThresholding: true, samplingMetadatas: [{ samplesReadCount: "10", samplingSpaceSize: "100" }] },
        propertyQuota: { tokensPerDay: { consumed: 5, remaining: 1_000 }, tokensPerHour: { consumed: 5, remaining: 900 } },
      }),
    );
    const r = await runReport(live("day", { to: "2026-11-20" }), d);
    expect(r.ok && r.notes).toEqual([THRESHOLD_NOTE, SAMPLED_NOTE, QUOTA_NOTE, notFinalNote("2026-11-20", "2026-11-20")]);
  });

  it("refuses a stream, grouping or property it doesn't know before calling, and reads Google's refusals", async () => {
    const { transport, deps: d } = deps();
    expect(await runReport(live("day", { stream: "zone_daily" }), d)).toMatchObject({ ok: false, code: "query_refused" });
    expect(await runReport({ ...live("day"), query: { ...live("day").query, by: "topic" } }, d)).toMatchObject({ ok: false, code: "query_refused" });
    expect(await runReport({ ...live("day"), account: "" }, d)).toMatchObject({ ok: false, code: "account_needed" });
    expect(await runReport({ ...live("day"), account: "properties/1/../2" }, d)).toMatchObject({ ok: false, code: "account_refused" });
    expect(transport).not.toHaveBeenCalled();
    expect(await runReport(live("day"), deps(answer({ error: { status: "RESOURCE_EXHAUSTED" } }, 429)).deps)).toMatchObject({ code: "rate_limited" });
    expect(await runReport(live("day"), deps(answer({ error: { status: "PERMISSION_DENIED", message: "User does not have sufficient permissions for this property." } }, 403)).deps)).toMatchObject({
      code: "account_refused",
    });
  });

  it("reaches people and agents through readLive with every number's meaning, the totals and the period in words", async () => {
    const { deps: d } = deps(
      answer({ metricHeaders: header, rows: [{ dimensionValues: [{ value: "20261101" }], metricValues: values(9, 8, 30, 1) }], totals: [{ metricValues: values(9, 8, 30, 1) }], metadata: LONDON }),
    );
    const r = await readLive({ ...input(), query: { stream: "site_traffic", from: "2026-11-01", to: "2026-11-01", by: "day", limit: 100 } }, d);
    if (!r.ok) throw new Error("read failed");
    expect(Object.keys(r.answer.meanings)).toEqual(["ga4Sessions", "ga4ActiveUsers", "ga4Views", "ga4KeyEvents"]);
    expect(r.answer.totals).toEqual({ ga4Sessions: 9, ga4ActiveUsers: 8, ga4Views: 30, ga4KeyEvents: 1 });
    expect(r.answer.period.words).toBe("1 Nov 2026, United Kingdom time");
    expect(r.answer).not.toHaveProperty("lag");
  });

  it("dates its notes in house style", () => {
    for (const t of [notFinalNote("2026-11-19", "2026-11-20"), showingNote("landing", 50, 212), showingNote("page", 10, 11)]) {
      expect(dashesIn(t), t).toEqual([]);
      expect(aiTellsIn(t), t).toEqual([]);
    }
  });
});
