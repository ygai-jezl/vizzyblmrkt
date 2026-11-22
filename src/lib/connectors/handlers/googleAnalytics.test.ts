import { describe, expect, it, vi } from "vitest";
import { parseManifest } from "../manifest";
import { ga4Manifest } from "../manifests/ga4";
import { readLive } from "../live";
import { MAX_PROPERTIES, NOT_FINAL_NOTE, OTHER_NOTE, properties, propertyCheck, QUOTA_NOTE, runReport, SAMPLED_NOTE, summariesFrom, THRESHOLD_NOTE } from "./googleAnalytics";

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

const live = (by: "day" | "page", over: Record<string, unknown> = {}) => ({
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
  it("reads a property by day with returnPropertyQuota, the property in the address and nothing else from outside", async () => {
    const { transport, deps: d } = deps(
      answer({
        dimensionHeaders: [{ name: "date" }],
        metricHeaders: header,
        rows: [
          { dimensionValues: [{ value: "20261102" }], metricValues: values(12, 10, 40, 2) },
          { dimensionValues: [{ value: "20261101" }], metricValues: values(9, 8, 30, 1) },
        ],
        propertyQuota: { tokensPerDay: { consumed: 3, remaining: 199_000 }, tokensPerHour: { consumed: 3, remaining: 39_000 } },
      }),
    );
    expect(await runReport(live("day"), d)).toEqual({
      ok: true,
      rows: [
        { day: "2026-11-01", ga4Sessions: 9, ga4ActiveUsers: 8, ga4Views: 30, ga4KeyEvents: 1 },
        { day: "2026-11-02", ga4Sessions: 12, ga4ActiveUsers: 10, ga4Views: 40, ga4KeyEvents: 2 },
      ],
      notes: [],
    });
    expect(transport.mock.calls[0]![0]).toBe("https://analyticsdata.googleapis.com/v1beta/properties/1000:runReport");
    expect(JSON.parse(String(transport.mock.calls[0]![1].body))).toEqual({
      dateRanges: [{ startDate: "2026-11-01", endDate: "2026-11-15" }],
      dimensions: [{ name: "date" }],
      metrics: [{ name: "sessions" }, { name: "activeUsers" }, { name: "screenPageViews" }, { name: "keyEvents" }],
      orderBys: [{ dimension: { dimensionName: "date" } }],
      limit: 100,
      keepEmptyRows: false,
      returnPropertyQuota: true,
    });
  });

  it("reads by page path, most viewed first, leaving out (other) and (not set) with a note", async () => {
    const { transport, deps: d } = deps(
      answer({
        metricHeaders: header,
        rows: [
          { dimensionValues: [{ value: "/blog/notes" }], metricValues: values(5, 5, 9, 0) },
          { dimensionValues: [{ value: "/pricing" }], metricValues: values(7, 6, 20, 3) },
          { dimensionValues: [{ value: "(other)" }], metricValues: values(50, 40, 90, 1) },
          { dimensionValues: [{ value: "(not set)" }], metricValues: values(1, 1, 1, 0) },
        ],
        metadata: { dataLossFromOtherRow: true },
      }),
    );
    const r = await runReport(live("page"), d);
    expect(r).toEqual({
      ok: true,
      rows: [
        { page: "/pricing", ga4Sessions: 7, ga4ActiveUsers: 6, ga4Views: 20, ga4KeyEvents: 3 },
        { page: "/blog/notes", ga4Sessions: 5, ga4ActiveUsers: 5, ga4Views: 9, ga4KeyEvents: 0 },
      ],
      notes: [OTHER_NOTE],
    });
    expect(JSON.parse(String(transport.mock.calls[0]![1].body)).orderBys).toEqual([{ metric: { metricName: "screenPageViews" }, desc: true }]);
  });

  it("matches metrics by Google's header names, not their order", async () => {
    const shuffled = [{ name: "keyEvents" }, { name: "screenPageViews" }, { name: "activeUsers" }, { name: "sessions" }];
    const { deps: d } = deps(answer({ metricHeaders: shuffled, rows: [{ dimensionValues: [{ value: "20261101" }], metricValues: values(1, 30, 8, 9) }] }));
    const r = await runReport(live("day"), d);
    expect(r.ok && r.rows[0]).toEqual({ day: "2026-11-01", ga4Sessions: 9, ga4ActiveUsers: 8, ga4Views: 30, ga4KeyEvents: 1 });
  });

  it("notes thresholds, sampling, a property low on tokens and days not yet final", async () => {
    const { deps: d } = deps(
      answer({
        metricHeaders: header,
        rows: [],
        metadata: { subjectToThresholding: true, samplingMetadatas: [{ samplesReadCount: "10", samplingSpaceSize: "100" }] },
        propertyQuota: { tokensPerDay: { consumed: 5, remaining: 1_000 }, tokensPerHour: { consumed: 5, remaining: 900 } },
      }),
    );
    const r = await runReport(live("day", { to: "2026-11-20" }), d);
    expect(r.ok && r.notes).toEqual([THRESHOLD_NOTE, SAMPLED_NOTE, QUOTA_NOTE, NOT_FINAL_NOTE]);
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

  it("reaches people and agents through readLive with every number's meaning", async () => {
    const { deps: d } = deps(answer({ metricHeaders: header, rows: [{ dimensionValues: [{ value: "20261101" }], metricValues: values(9, 8, 30, 1) }] }));
    const r = await readLive({ ...input(), query: { stream: "site_traffic", from: "2026-11-01", to: "2026-11-01", by: "day", limit: 100 } }, d);
    expect(r.ok && Object.keys(r.answer.meanings)).toEqual(["ga4Sessions", "ga4ActiveUsers", "ga4Views", "ga4KeyEvents"]);
    expect(r.ok && r.answer.lag.words).toBe("A day's numbers are complete about 2 days later.");
  });
});
