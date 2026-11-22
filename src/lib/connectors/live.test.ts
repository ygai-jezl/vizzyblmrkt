import { describe, expect, it, vi } from "vitest";
import { MEANINGS, numberKeys } from "@/lib/metrics/meanings";

const hook = vi.hoisted(() => ({ live: vi.fn() }));
vi.mock("./handlers", () => ({ VERIFY_HOOKS: {}, LIVE_HOOKS: { "cloudflare.zoneDaily": (...a: unknown[]) => hook.live(...a) } }));
import { parseManifest } from "./manifest";
import { cloudflareManifest } from "./manifests/cloudflare";
import { checkLiveRequest, cleanPagePath, lagWords, readLive } from "./live";

const manifest = parseManifest(cloudflareManifest);
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
});

describe("readLive", () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ day: `2026-11-1${i}`, cfRequests: 10 + i, cfPageViews: 5, cfVisits: 2, secretNumber: 99, label: "x" }));

  it("keeps only the stream's keys and measures, caps rows, and gives every number its meaning", async () => {
    hook.live.mockResolvedValueOnce({ ok: true, rows, notes: ["a note"] });
    const r = await readLive({ ...base, query: { stream: "zone_daily", from: "2026-11-10", to: "2026-11-14", by: "day", limit: 3 } }, { now: NOW });
    expect(hook.live.mock.calls[0]![0]).toMatchObject({ today: "2026-11-21", account: base.account });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.answer.rows).toEqual([
      { day: "2026-11-10", cfRequests: 10, cfPageViews: 5, cfVisits: 2 },
      { day: "2026-11-11", cfRequests: 11, cfPageViews: 5, cfVisits: 2 },
      { day: "2026-11-12", cfRequests: 12, cfPageViews: 5, cfVisits: 2 },
    ]);
    for (const k of numberKeys(r.answer.rows)) expect(r.answer.meanings[k as keyof typeof MEANINGS], k).toEqual(MEANINGS[k as keyof typeof MEANINGS]);
    expect(r.answer).toMatchObject({ connectorId: "cloudflare", stream: "zone_daily", lag: { days: 1, words: "A day's numbers are complete the next day." }, notes: ["a note"], asOf: NOW.toISOString() });
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
    expect(lagWords(3)).toBe("A day's numbers are complete about 3 days later.");
  });
});
