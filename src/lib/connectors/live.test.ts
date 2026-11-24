import { describe, expect, it, vi } from "vitest";
import { MEANINGS, numberKeys } from "@/lib/metrics/meanings";

const hook = vi.hoisted(() => ({ live: vi.fn() }));
vi.mock("./handlers", () => ({ VERIFY_HOOKS: {}, LIVE_HOOKS: { "cloudflare.zoneDaily": (...a: unknown[]) => hook.live(...a) } }));
import { parseManifest } from "./manifest";
import { cloudflareManifest } from "./manifests/cloudflare";
import { ga4Manifest } from "./manifests/ga4";
import { searchConsoleManifest } from "./manifests/searchConsole";
import { checkLiveRequest, cleanPagePath, lagWords, readLive } from "./live";

const manifest = parseManifest(cloudflareManifest);
const sc = parseManifest(searchConsoleManifest);
const ga4 = parseManifest(ga4Manifest);
const PERIOD = { from: "2026-11-10", to: "2026-11-14", timeZone: "UTC", finalThrough: "2026-11-14" };
const NOW = new Date("2026-11-21T10:00:00.000Z");
const health = { state: "ok" as const, lastOkAt: null, lastCheckedAt: null, lastErrorCode: null, failures: 0, pausedUntil: null };
const base = { manifest, connection: { id: "dcn_aaaaaaaaaaaaaaaaaaaa", tenantId: "ten_a", pausedAt: null, health }, account: "0123456789abcdef0123456789abcdef", token: "made-up-token-000000000000" };

describe("checkLiveRequest", () => {
  it("accepts up to 93 days, grouped by a dimension the stream allows", () => {
    expect(checkLiveRequest(manifest, { stream: "zone_daily", from: "2026-08-21", to: "2026-11-21" }, NOW)).toEqual({
      ok: true,
      query: { stream: "zone_daily", from: "2026-08-21", to: "2026-11-21", by: "day", limit: 100 },
    });
    expect(checkLiveRequest(manifest, { stream: "zone_daily", from: "2026-08-20", to: "2026-11-21" }, NOW)).toEqual({ ok: false, error: "too_many_days" });
  });

  it("refuses a bad stream, grouping, dates, limit and anything extra", () => {
    const q = { stream: "zone_daily", from: "2026-11-01", to: "2026-11-20" };
    expect(checkLiveRequest(manifest, { ...q, stream: "orders" }, NOW)).toEqual({ ok: false, error: "unknown_stream" });
    expect(checkLiveRequest(manifest, { ...q, by: "page" }, NOW)).toEqual({ ok: false, error: "by_not_allowed" });
    expect(checkLiveRequest(manifest, { ...q, by: "country" }, NOW)).toEqual({ ok: false, error: "invalid_input" });
    expect(checkLiveRequest(manifest, { ...q, from: "2026-11-21", to: "2026-11-20" }, NOW)).toEqual({ ok: false, error: "bad_dates" });
    expect(checkLiveRequest(manifest, { ...q, to: "2026-11-22" }, NOW)).toEqual({ ok: false, error: "bad_dates" });
    expect(checkLiveRequest(manifest, { ...q, from: "2026-02-30" }, NOW)).toEqual({ ok: false, error: "bad_dates" });
    expect(checkLiveRequest(manifest, { ...q, limit: "101" }, NOW)).toEqual({ ok: false, error: "invalid_input" });
    expect(checkLiveRequest(manifest, { ...q, token: "x" }, NOW)).toEqual({ ok: false, error: "invalid_input" });
    expect(checkLiveRequest(manifest, { ...q, limit: "10" }, NOW)).toMatchObject({ ok: true, query: { limit: 10 } });
  });

  it("takes a named period instead of dates, never both, and leaves the days to the connector", () => {
    expect(checkLiveRequest(manifest, { stream: "zone_daily", period: "last_28_days" }, NOW)).toEqual({ ok: true, query: { stream: "zone_daily", period: "last_28_days", by: "day", limit: 100 } });
    expect(checkLiveRequest(sc, { stream: "search_performance", period: "last_90_days", by: "page", limit: 50 }, NOW)).toMatchObject({ ok: true, query: { period: "last_90_days" } });
    expect(checkLiveRequest(manifest, { stream: "zone_daily", period: "last_28_days", from: "2026-11-01", to: "2026-11-20" }, NOW)).toEqual({ ok: false, error: "invalid_input" });
    expect(checkLiveRequest(manifest, { stream: "zone_daily", period: "last_28_days", to: "2026-11-20" }, NOW)).toEqual({ ok: false, error: "invalid_input" });
    expect(checkLiveRequest(manifest, { stream: "zone_daily", from: "2026-11-01" }, NOW)).toEqual({ ok: false, error: "invalid_input" });
    expect(checkLiveRequest(manifest, { stream: "zone_daily" }, NOW)).toEqual({ ok: false, error: "invalid_input" });
    expect(checkLiveRequest(manifest, { stream: "zone_daily", period: "last_year" }, NOW)).toEqual({ ok: false, error: "invalid_input" });
  });

  it("checks explicit days against today in the provider's zone: Pacific for Search Console", () => {
    // 05:00 UTC on 22 Nov is 21 Nov in Pacific time, so 22 Nov is a day that hasn't started there.
    const early = new Date("2026-11-22T05:00:00.000Z");
    const q = { stream: "search_performance", from: "2026-11-01" };
    expect(checkLiveRequest(sc, { ...q, to: "2026-11-22" }, early)).toEqual({ ok: false, error: "bad_dates" });
    expect(checkLiveRequest(sc, { ...q, to: "2026-11-21" }, early)).toMatchObject({ ok: true });
    expect(checkLiveRequest(manifest, { stream: "zone_daily", from: "2026-11-01", to: "2026-11-22" }, early)).toMatchObject({ ok: true });
  });

  it("allows a page filter and the landing grouping only where the stream lists them", () => {
    expect(checkLiveRequest(sc, { stream: "search_performance", period: "last_28_days", by: "day", page: "/features/example" }, NOW)).toMatchObject({
      ok: true,
      query: { page: "/features/example" },
    });
    expect(checkLiveRequest(ga4, { stream: "site_traffic", period: "last_7_days", by: "landing", page: "/pricing" }, NOW)).toMatchObject({ ok: true, query: { by: "landing" } });
    expect(checkLiveRequest(sc, { stream: "search_performance", period: "last_7_days", by: "landing" }, NOW)).toEqual({ ok: false, error: "by_not_allowed" });
    expect(checkLiveRequest(manifest, { stream: "zone_daily", period: "last_7_days", page: "/pricing" }, NOW)).toEqual({ ok: false, error: "page_not_allowed" });
    for (const page of ["pricing", "/pricing?ref=x", "/a b", "/#top", `/${"a".repeat(600)}`]) {
      expect(checkLiveRequest(sc, { stream: "search_performance", period: "last_7_days", page }, NOW), page).toEqual({ ok: false, error: "invalid_input" });
    }
  });
});

describe("readLive", () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ day: `2026-11-1${i}`, cfRequests: 10 + i, cfPageViews: 5, cfVisits: 2, secretNumber: 99, label: "x" }));

  it("keeps only the stream's keys and measures, keeps the latest days when it cuts, and gives every number its meaning", async () => {
    hook.live.mockResolvedValueOnce({ ok: true, rows, notes: ["a note", "a note"], period: PERIOD });
    const r = await readLive({ ...base, query: { stream: "zone_daily", from: "2026-11-10", to: "2026-11-14", by: "day", limit: 3 } }, { now: NOW });
    expect(hook.live.mock.calls[0]![0]).toMatchObject({ today: "2026-11-21", account: base.account });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.answer.rows).toEqual([
      { day: "2026-11-12", cfRequests: 12, cfPageViews: 5, cfVisits: 2 },
      { day: "2026-11-13", cfRequests: 13, cfPageViews: 5, cfVisits: 2 },
      { day: "2026-11-14", cfRequests: 14, cfPageViews: 5, cfVisits: 2 },
    ]);
    for (const k of numberKeys(r.answer)) expect(r.answer.meanings[k as keyof typeof MEANINGS], k).toEqual(MEANINGS[k as keyof typeof MEANINGS]);
    expect(Object.keys(r.answer.meanings)).toEqual(["cfRequests", "cfPageViews", "cfVisits"]);
    expect(r.answer).toMatchObject({
      connectorId: "cloudflare",
      connector: "Cloudflare",
      stream: "zone_daily",
      period: { ...PERIOD, words: "10 Nov to 14 Nov 2026, UTC" },
      totals: null,
      more: true,
      notes: ["a note"],
      asOf: NOW.toISOString(),
    });
    expect(r.answer).not.toHaveProperty("lag");
  });

  it("keeps the first rows of any other grouping, the hook's most important, and only totals with a meaning", async () => {
    const pages = [{ page: "https://example.com/a?x=1", ga4Views: 9 }, { page: "/b", ga4Views: 5 }, { page: "/c", ga4Views: 1 }];
    hook.live.mockResolvedValueOnce({ ok: true, rows: pages, notes: [], period: PERIOD, totals: { ga4Views: 15, secretNumber: 4 }, more: false });
    const cf = { ...manifest, produces: [{ ...manifest.produces[0]!, keys: ["day", "page"], measures: ["ga4Views" as const], joins: { day: "day" as const, page: "page" as const } }] };
    const r = await readLive({ ...base, manifest: cf, query: { stream: "zone_daily", period: "last_7_days", by: "page", limit: 2 } }, { now: NOW });
    if (!r.ok) throw new Error("read failed");
    expect(r.answer.rows).toEqual([
      { page: "/a", ga4Views: 9 },
      { page: "/b", ga4Views: 5 },
    ]);
    expect(r.answer.totals).toEqual({ ga4Views: 15 });
    expect(r.answer.more).toBe(true);
  });

  it("passes a hook's failure through", async () => {
    hook.live.mockResolvedValueOnce({ ok: false, code: "token_refused", retryAfterSec: null });
    const r = await readLive({ ...base, query: { stream: "zone_daily", from: "2026-11-10", to: "2026-11-14", by: "day", limit: 3 } }, { now: NOW });
    expect(r).toEqual({ ok: false, code: "token_refused", retryAfterSec: null });
  });
});

describe("words and pages", () => {
  it("writes pages without query strings or fragments", () => {
    expect(cleanPagePath("https://example.com/pricing?utm_source=x#top")).toBe("/pricing");
    expect(cleanPagePath("/blog/post?ref=abc")).toBe("/blog/post");
    expect(cleanPagePath("about")).toBe("/about");
  });

  it("says the lag in plain words", () => {
    expect(lagWords(0)).toBe("Numbers arrive within minutes.");
    expect(lagWords(3)).toBe("A day's numbers are final about 3 days later.");
  });
});
