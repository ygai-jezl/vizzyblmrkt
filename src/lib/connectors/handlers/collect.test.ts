import { describe, expect, it } from "vitest";
import { collectedStream, parseManifest } from "../manifest";
import { cloudflareManifest } from "../manifests/cloudflare";
import { ga4Manifest } from "../manifests/ga4";
import { searchConsoleManifest } from "../manifests/searchConsole";
import { EMPTY_CURSOR, type CollectCursor } from "../collect/schedule";
import { answer, cfDays, cfSettings, ga4Day, routedTransport, SC_QUOTA, scDays, scRows, type SeenCall } from "../testing/providers";
import { COLLECT_HOOKS } from "./index";
import type { CollectAsk } from "./types";

// Every provider here is a stub transport with made-up numbers for a made-up site.
const health = { state: "ok" as const, lastOkAt: null, lastCheckedAt: null, lastErrorCode: null, failures: 0, pausedUntil: null };
const connection = { id: "dcn_aaaaaaaaaaaaaaaaaaaa", tenantId: "ten_a", pausedAt: null, health };

function run(manifestInput: unknown, account: string, route: (c: SeenCall) => Response, cursor: CollectCursor = EMPTY_CURSOR, now = new Date("2026-11-23T12:00:00.000Z")) {
  const manifest = parseManifest(manifestInput);
  const stream = collectedStream(manifest)!;
  const { transport, calls } = routedTransport(route);
  const ask: CollectAsk = { stream, cursor, now, canStart: () => true };
  const hook = COLLECT_HOOKS[manifest.hooks.collect!]!;
  return { calls, result: hook({ manifest, connection, account, token: "made-up-token", ask }, { transport, limit: async () => false, log: () => {}, now }) };
}

describe("Search Console's collect", () => {
  const SITE = "sc-domain:example.com";
  const PROBE = scDays([
    { day: "2026-11-18", clicks: 10, impressions: 400 },
    { day: "2026-11-20", clicks: 12, impressions: 500 },
  ]);
  const route = (c: SeenCall) => {
    const dims = c.body.dimensions as string[];
    if (dims[0] === "date") return answer(PROBE);
    if (dims[0] === "page") return answer(scRows([{ key: "https://example.com/pricing?x=1", clicks: 4, impressions: 90 }, { key: "https://example.com/pricing", clicks: 3, impressions: 60 }]));
    return answer(scRows([{ key: "made up search", clicks: 5, impressions: 100 }]));
  };

  it("collects only final days the probe lists, with each day's totals from the probe, zeros for a day it skips", async () => {
    const { calls, result } = run(searchConsoleManifest, SITE, route, { ...EMPTY_CURSOR, lastDay: "2026-11-17", backfilledTo: "2026-09-01", finalThrough: "2026-11-17", filled: true });
    const r = await result;
    expect(calls[0]!.body).toMatchObject({ dimensions: ["date"], type: "web", dataState: "final", endDate: "2026-11-23" });
    expect(r.newest).toBe("2026-11-20");
    expect(r.days.map((d) => d.day)).toEqual(["2026-11-18", "2026-11-19", "2026-11-20"]);
    // 19 Nov isn't listed but is before the frontier: zeros, and no page or search call for it.
    const zero = r.days.find((d) => d.day === "2026-11-19")!;
    expect(zero.docs.find((d) => d.by === "day")!.totals).toEqual({ searchClicks: 0, searchImpressions: 0, searchCtr: null, searchPosition: null });
    expect(calls.filter((c) => c.body.startDate === "2026-11-19")).toHaveLength(0);
    // Every page and search call is one day, final numbers, 1,000 rows.
    for (const c of calls.slice(1)) expect(c.body).toMatchObject({ startDate: c.body.endDate, dataState: "final", rowLimit: 1000 });
    const day20 = r.days.find((d) => d.day === "2026-11-20")!;
    expect(day20.final).toBe(true);
    expect(day20.docs.find((d) => d.by === "day")!.totals).toMatchObject({ searchClicks: 12, searchImpressions: 500 });
    // Addresses for the same host and path are added together, the path kept as the key.
    expect(day20.docs.find((d) => d.by === "page")!.rows).toEqual([{ key: "/pricing", host: "example.com", m: { searchClicks: 7, searchImpressions: 150, searchCtr: 7 / 150, searchPosition: 8, merged: 2 } }]);
    expect(day20.docs.find((d) => d.by === "topic")!.rows[0]).toMatchObject({ key: "made up search", m: { searchClicks: 5 } });
    // A day after the frontier is never collected.
    expect(r.days.some((d) => d.day > "2026-11-20")).toBe(false);
  });

  it("fills newest first, 5 days a run, the probe reaching over the keep window", async () => {
    const many = scDays(Array.from({ length: 10 }, (_, i) => ({ day: `2026-11-${String(11 + i).padStart(2, "0")}`, clicks: i, impressions: 10 * i + 1 })));
    const { calls, result } = run(searchConsoleManifest, SITE, (c) => ((c.body.dimensions as string[])[0] === "date" ? answer(many) : answer(scRows([]))));
    const r = await result;
    expect(r.days.map((d) => d.day)).toEqual(["2026-11-20", "2026-11-19", "2026-11-18", "2026-11-17", "2026-11-16"]);
    expect(calls[0]!.body.startDate).toBe("2026-08-16");
    expect(calls).toHaveLength(11);
  });

  it("says Google may have more when it sends 1,000 rows", async () => {
    const full = scRows(Array.from({ length: 1000 }, (_, i) => ({ key: `search ${i}`, clicks: 1, impressions: 2 })));
    const { result } = run(searchConsoleManifest, SITE, (c) => ((c.body.dimensions as string[])[0] === "date" ? answer(PROBE) : answer(full)), { ...EMPTY_CURSOR, lastDay: "2026-11-19", backfilledTo: "2026-09-01", finalThrough: "2026-11-19", filled: true });
    const r = await result;
    expect(r.days[0]!.docs.find((d) => d.by === "topic")!.more).toBe(true);
  });

  it("writes nothing and asks to wait when the probe lists no day", async () => {
    const { calls, result } = run(searchConsoleManifest, SITE, () => answer({}));
    expect(await result).toMatchObject({ days: [], probed: true, hold: { reason: "no_data" }, failure: null });
    expect(calls).toHaveLength(1);
  });

  it("stops at Google's quota answer, keeping the days already read", async () => {
    let n = 0;
    const { result } = run(searchConsoleManifest, SITE, (c) => {
      if ((c.body.dimensions as string[])[0] === "date") return answer(PROBE);
      n += 1;
      return n <= 2 ? answer(scRows([])) : answer(SC_QUOTA, 403);
    }, { ...EMPTY_CURSOR, lastDay: "2026-11-17", backfilledTo: "2026-09-01", finalThrough: "2026-11-17", filled: true });
    const r = await result;
    expect(r.failure).toMatchObject({ code: "rate_limited" });
    expect(r.days.map((d) => d.day)).toEqual(["2026-11-18", "2026-11-19"]);
  });
});

describe("Google Analytics' collect", () => {
  const PROPERTY = "properties/123456789";
  const batch = (c: SeenCall, over: Parameters<typeof ga4Day>[0] = {}) => answer({ reports: (c.body.requests as unknown[]).length === 4 ? [...ga4Day(over), ...ga4Day(over)] : ga4Day(over) });

  it("reads one day per report, at most 4 reports a call, marking days final only from day 8", async () => {
    const { calls, result } = run(ga4Manifest, PROPERTY, (c) => batch(c), { ...EMPTY_CURSOR, timeZone: "Europe/London" });
    const r = await result;
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      // Compact JSON: Google pretty prints by default, which would double the answer.
      expect(c.url).toBe("https://analyticsdata.googleapis.com/v1beta/properties/123456789:batchRunReports?prettyPrint=false");
      const requests = c.body.requests as Array<{ dateRanges: Array<{ startDate: string; endDate: string }>; limit: number; returnPropertyQuota: boolean; metricAggregations: string[] }>;
      expect(requests.length).toBeLessThanOrEqual(5);
      for (const q of requests) expect(q).toMatchObject({ limit: 500, returnPropertyQuota: true, metricAggregations: ["TOTAL"], dateRanges: [{ startDate: q.dateRanges[0]!.endDate }] });
    }
    // At 12:00 in London on 23 Nov: 21 Nov is the newest day; days up to 15 Nov are final.
    expect(r.days.map((d) => `${d.day}:${d.final}`)).toEqual(["2026-11-21:false", "2026-11-20:false", "2026-11-19:false", "2026-11-18:false", "2026-11-17:false", "2026-11-16:false"]);
    expect(r.timeZone).toBe("Europe/London");
  });

  it("keeps the day's totals, leaves out (other) and (not set), and adds a landing page's variants without its users", async () => {
    const { result } = run(ga4Manifest, PROPERTY, (c) => batch(c, { other: true }), { ...EMPTY_CURSOR, lastDay: "2026-11-20", backfilledTo: "2026-08-24", finalThrough: "2026-11-15", filled: true, timeZone: "Europe/London" });
    const r = await result;
    const day = r.days.find((d) => d.day === "2026-11-21")!;
    expect(day.docs.find((d) => d.by === "day")!.totals).toEqual({ ga4Sessions: 80, ga4ActiveUsers: 60, ga4Views: 120, ga4KeyEvents: 4 });
    const page = day.docs.find((d) => d.by === "page")!;
    expect(page.rows.map((x) => x.key)).toEqual(["/pricing", "/blog/first-post"]);
    expect(page.notes).toContain("other_row");
    const landing = day.docs.find((d) => d.by === "landing")!;
    expect(landing.rows).toEqual([{ key: "/pricing", m: { ga4Sessions: 50, ga4KeyEvents: 3 } }]);
    // Only the new day: every day up to 15 Nov is final already.
    expect(r.days.map((d) => `${d.day}:${d.final}`)).toEqual(["2026-11-21:false"]);
  });

  it("reads a day again on day 8, then marks it final", async () => {
    const { result } = run(ga4Manifest, PROPERTY, (c) => batch(c), { ...EMPTY_CURSOR, lastDay: "2026-11-21", backfilledTo: "2026-08-24", finalThrough: "2026-11-13", filled: true, timeZone: "Europe/London" });
    expect((await result).days.map((d) => `${d.day}:${d.final}`)).toEqual(["2026-11-14:true", "2026-11-15:true"]);
  });

  const tooBig = () => new Response("x".repeat(600 * 1024), { status: 200, headers: { "content-type": "application/json" } });
  const twoNew = { ...EMPTY_CURSOR, lastDay: "2026-11-19", backfilledTo: "2026-08-24", finalThrough: "2026-11-15", filled: true, timeZone: "Europe/London" };

  it("asks one day a call when two days are too big, then that day with half the rows", async () => {
    let n = 0;
    const { calls, result } = run(ga4Manifest, PROPERTY, (c) => {
      n += 1;
      return n === 1 || n === 3 ? tooBig() : batch(c);
    }, twoNew);
    const r = await result;
    expect(r.failure).toBeNull();
    expect(r.hold).toBeNull();
    expect(r.days.map((d) => d.day)).toEqual(["2026-11-20", "2026-11-21"]);
    const asked = calls.map((c) => (c.body.requests as Array<{ limit: number; dateRanges: Array<{ startDate: string }> }>).map((q) => `${q.dateRanges[0]!.startDate}:${q.limit}`));
    expect(asked).toEqual([
      ["2026-11-20:500", "2026-11-20:500", "2026-11-21:500", "2026-11-21:500"],
      ["2026-11-20:500", "2026-11-20:500"],
      ["2026-11-21:500", "2026-11-21:500"],
      ["2026-11-21:250", "2026-11-21:250"],
    ]);
  });

  it("holds itself until the next day when one day is too big even with half the rows, leaving health alone", async () => {
    let n = 0;
    const { result } = run(ga4Manifest, PROPERTY, (c) => {
      n += 1;
      return n === 2 ? batch(c) : tooBig();
    }, twoNew);
    const r = await result;
    expect(r.failure).toBeNull();
    expect(r.hold).toMatchObject({ reason: "too_big" });
    // The day before it landed; the cursor waits on the one too big.
    expect(r.days.map((d) => d.day)).toEqual(["2026-11-20"]);
  });

  it("stores zeros for a day with no rows and no totals, never an empty total", async () => {
    const empty = (metrics: string[]) => ({ dimensionHeaders: [{ name: "x" }], metricHeaders: metrics.map((name) => ({ name, type: "TYPE_INTEGER" })), metadata: { timeZone: "Europe/London" }, kind: "analyticsData#runReport" });
    const day = () => [empty(["screenPageViews", "activeUsers", "keyEvents"]), empty(["sessions", "activeUsers", "keyEvents"])];
    const { result } = run(ga4Manifest, PROPERTY, (c) => answer({ reports: (c.body.requests as unknown[]).length === 4 ? [...day(), ...day()] : day() }), twoNew);
    const r = await result;
    expect(r.days[0]!.docs.find((d) => d.by === "day")!.totals).toEqual({ ga4Sessions: 0, ga4ActiveUsers: 0, ga4Views: 0, ga4KeyEvents: 0 });
  });

  it("plans a first run in the westernmost zone, so the property's own day never finds the cursor ahead", async () => {
    // 06:30 UTC on 24 Nov: in UTC the newest day would be 22 Nov, a day ahead of a Los Angeles property.
    const { result } = run(ga4Manifest, PROPERTY, (c) => batch(c, { timeZone: "America/Los_Angeles" }), EMPTY_CURSOR, new Date("2026-11-24T06:30:00.000Z"));
    const r = await result;
    expect(r.newest).toBe("2026-11-21");
    expect(r.days[0]!.day).toBe("2026-11-21");
    expect(r.timeZone).toBe("America/Los_Angeles");
  });

  it("holds itself for an hour when the project's tokens for the property run low", async () => {
    const now = new Date("2026-11-23T12:00:00.000Z");
    const { calls, result } = run(ga4Manifest, PROPERTY, (c) => batch(c, { projectHourLeft: 1000 }), { ...EMPTY_CURSOR, timeZone: "Europe/London" }, now);
    const r = await result;
    expect(calls).toHaveLength(1);
    expect(r.days).toHaveLength(2);
    expect(r.hold).toEqual({ untilMs: now.getTime() + 3_600_000, reason: "tokens_low" });
  });

  it("turns notes about sampling and thresholds into codes", async () => {
    const reports = ga4Day();
    (reports[0]!.metadata as Record<string, unknown>).samplingMetadatas = [{ samplesReadCount: "1" }];
    (reports[1]!.metadata as Record<string, unknown>).subjectToThresholding = true;
    const { result } = run(ga4Manifest, PROPERTY, () => answer({ reports: [...reports, ...reports] }), { ...EMPTY_CURSOR, lastDay: "2026-11-19", backfilledTo: "2026-08-24", finalThrough: "2026-11-15", filled: true, timeZone: "Europe/London" });
    const r = await result;
    expect(r.days[0]!.docs.find((d) => d.by === "day")!.notes).toEqual(expect.arrayContaining(["sampled", "thresholded"]));
  });
});

describe("Cloudflare's collect", () => {
  const ZONE = "0123456789abcdef0123456789abcdef";
  const now = new Date("2026-11-23T12:00:00.000Z");

  it("reads its settings for both datasets, then every day in one query, with each day's basis", async () => {
    const all = Array.from({ length: 90 }, (_, i) => new Date(Date.parse("2026-08-24") + i * 86_400_000).toISOString().slice(0, 10));
    const { calls, result } = run(cloudflareManifest, ZONE, (c) => (String(c.body.query).includes("settings") ? answer(cfSettings()) : answer(cfDays(all, all.slice(-30)))), EMPTY_CURSOR, now);
    const r = await result;
    expect(String(calls[0]!.body.query)).toContain("httpRequests1dGroups { enabled notOlderThan maxDuration }");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.variables).toMatchObject({ from: "2026-08-24", to: "2026-11-21" });
    expect(r.days).toHaveLength(90);
    const newest = r.days.at(-1)!;
    expect(newest).toMatchObject({ day: "2026-11-21", final: true });
    expect(newest.docs[0]).toMatchObject({ by: "day", basis: "end_users" });
    expect(newest.docs[0]!.totals).toMatchObject({ cfRequests: 1529, cfPageViews: 279, cfVisits: 149, cfUniqueVisitors: 179 });
    const oldest = r.days[0]!.docs[0]!;
    expect(oldest).toMatchObject({ basis: "all_traffic", totals: { cfRequests: 2000, cfPageViews: 300, cfVisits: null, cfUniqueVisitors: 90 } });
  });

  it("clamps the backfill to how far back the zone's daily totals reach", async () => {
    const { calls, result } = run(cloudflareManifest, ZONE, (c) => (String(c.body.query).includes("settings") ? answer(cfSettings({ dailyDays: 10 })) : answer(cfDays([]))), EMPTY_CURSOR, now);
    const r = await result;
    expect(r.reachFrom).toBe("2026-11-14");
    expect(calls[1]!.body.variables).toMatchObject({ from: "2026-11-14", to: "2026-11-21" });
    // Days with nothing listed, two days on, had no traffic.
    expect(r.days[0]!.docs[0]!.totals).toMatchObject({ cfRequests: 0, cfUniqueVisitors: 0 });
  });

  it("keeps a recent day only the daily totals list from them, never as zero end users", async () => {
    const all = Array.from({ length: 90 }, (_, i) => new Date(Date.parse("2026-08-24") + i * 86_400_000).toISOString().slice(0, 10));
    // The adaptive dataset lists the last 30 days but 20 Nov.
    const endUsers = all.slice(-30).filter((d) => d !== "2026-11-20");
    const { result } = run(cloudflareManifest, ZONE, (c) => (String(c.body.query).includes("settings") ? answer(cfSettings()) : answer(cfDays(all, endUsers))), EMPTY_CURSOR, now);
    const r = await result;
    const day = r.days.find((d) => d.day === "2026-11-20")!.docs[0]!;
    expect(day).toMatchObject({ basis: "all_traffic", totals: { cfVisits: null } });
    expect((day.totals as Record<string, number>).cfRequests).toBeGreaterThan(0);
    expect(r.days.find((d) => d.day === "2026-11-21")!.docs[0]).toMatchObject({ basis: "end_users" });
  });

  it("stops when the token is turned down", async () => {
    const { result } = run(cloudflareManifest, ZONE, () => answer({ data: null, errors: [{ message: "Unauthorized" }] }), EMPTY_CURSOR, now);
    expect((await result).failure).toMatchObject({ code: "token_refused" });
  });
});
