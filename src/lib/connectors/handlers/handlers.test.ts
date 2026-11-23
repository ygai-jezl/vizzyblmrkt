import { describe, expect, it, vi } from "vitest";
import { parseManifest } from "../manifest";
import { cloudflareManifest } from "../manifests/cloudflare";
import { allConnectors } from "../registry";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { ADAPTIVE_DEFAULTS, adaptiveFrom, adaptiveSettings, classifyErrors, END_USERS_NOTE, freePlanNote, MAX_ZONES, NO_TOTALS_NOTE, olderDaysNote, zoneDaily, zonePage, zoneProbe, zones } from "./cloudflare";
import { ACCOUNT_HOOKS, LIVE_HOOKS, VERIFY_HOOKS } from "./index";

// Cloudflare is never called: the transport is a stub that answers like its GraphQL API.
const manifest = parseManifest(cloudflareManifest);
const ZONE = "0123456789abcdef0123456789abcdef";
const TOKEN = "made-up-cloudflare-token-0000000000";
const NOW = new Date("2026-11-21T10:00:00.000Z");
const health = { state: "ok" as const, lastOkAt: null, lastCheckedAt: null, lastErrorCode: null, failures: 0, pausedUntil: null };
const input = { manifest, connection: { id: "dcn_aaaaaaaaaaaaaaaaaaaa", tenantId: "ten_a", pausedAt: null, health }, account: ZONE, token: TOKEN };

const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function deps(...responses: Response[]) {
  const transport = vi.fn(async (_url: string, _init: RequestInit) => responses.shift() ?? answer({ data: null, errors: [{ message: "no more answers" }] }));
  return { transport, deps: { transport, limit: async () => false, log: () => {}, now: NOW } };
}
const sentBody = (t: { mock: { calls: Array<[string, RequestInit]> } }, i = 0) => JSON.parse(String(t.mock.calls[i]![1].body)) as { query: string; variables: Record<string, unknown> };

describe("connector hooks", () => {
  it("has code for every hook a manifest names", () => {
    for (const m of allConnectors()) {
      expect(VERIFY_HOOKS[m.verify.hook], m.verify.hook).toBeDefined();
      expect(LIVE_HOOKS[m.hooks.live], m.hooks.live).toBeDefined();
      if (m.hooks.accounts) expect(ACCOUNT_HOOKS[m.hooks.accounts], m.hooks.accounts).toBeDefined();
    }
  });
});

describe("Cloudflare zoneProbe", () => {
  it("passes when the token reads analytics for exactly this zone, sending the zone as a variable", async () => {
    const { transport, deps: d } = deps(answer({ data: { viewer: { zones: [{ httpRequests1dGroups: [] }] } }, errors: null }));
    expect(await zoneProbe(input, d)).toEqual({ ok: true });
    const body = sentBody(transport);
    expect(body.variables).toEqual({ zoneTag: ZONE, from: "2026-11-20", to: "2026-11-21" });
    expect(body.query).toContain("zones(filter: { zoneTag: $zoneTag })");
    expect(body.query).not.toContain(ZONE);
    expect(transport.mock.calls[0]![0]).toBe("https://api.cloudflare.com/client/v4/graphql");
  });

  it("reads the errors array even on HTTP 200", async () => {
    expect(await zoneProbe(input, deps(answer({ data: null, errors: [{ message: "Unauthorized" }] })).deps)).toMatchObject({ ok: false, code: "token_refused" });
    expect(await zoneProbe(input, deps(answer({ data: null, errors: [{ message: `zones [${ZONE}] are not authorized` }] })).deps)).toMatchObject({ code: "account_refused" });
    expect(await zoneProbe(input, deps(answer({ data: { viewer: { zones: [] } }, errors: null })).deps)).toMatchObject({ code: "account_refused" });
    expect(await zoneProbe(input, deps(answer({ data: { viewer: {} } })).deps)).toMatchObject({ code: "bad_response" });
  });

  it("refines an HTTP failure with Cloudflare's own errors", async () => {
    expect(await zoneProbe(input, deps(answer({ errors: [{ message: "not authorized for that account" }] }, 403)).deps)).toMatchObject({ code: "account_refused" });
    expect(await zoneProbe(input, deps(answer({ errors: [{ message: "rate limiter budget depleted, try again after 5 minutes" }] }, 429)).deps)).toMatchObject({ code: "rate_limited" });
    expect(await zoneProbe(input, deps(answer({}, 503)).deps)).toMatchObject({ code: "provider_error" });
  });
});

describe("Cloudflare zones, for the picker after Check", () => {
  const OTHER = "fedcba9876543210fedcba9876543210";
  const page = (result: unknown[], totalPages = 1) => ({ success: true, errors: [], messages: [], result, result_info: { page: 1, per_page: 50, count: result.length, total_count: result.length, total_pages: totalPages } });
  const zone = (id: string, name: string, status = "active") => ({ id, name, status, account: { id: "acc_made_up", name: "Acme" } });
  // A check has no connection yet: it stands in for one, and nothing about it is stored.
  const checking = { ...input, connection: { ...input.connection, id: "check" }, account: "" };

  it("lists the zones the token can see, by name, with the token only in the header", async () => {
    const { transport, deps: d } = deps(answer(page([zone(ZONE, "acme.example"), zone(OTHER, "shop.acme.example", "pending")])));
    expect(await zones(checking, d)).toEqual({
      ok: true,
      accounts: [
        { id: ZONE, label: "acme.example", detail: null },
        { id: OTHER, label: "shop.acme.example", detail: "Not active in Cloudflare yet" },
      ],
      more: false,
    });
    const [url, init] = transport.mock.calls[0]!;
    expect(url).toBe("https://api.cloudflare.com/client/v4/zones?page=1&per_page=50&order=name&direction=asc");
    expect(init.method).toBe("GET");
    expect(url).not.toContain(TOKEN);
  });

  it("reads up to 4 pages, then says there are more", async () => {
    const full = (n: number) => Array.from({ length: 50 }, (_, i) => zone((n * 50 + i).toString(16).padStart(32, "0"), `site-${n}-${i}.example`));
    const two = deps(answer(page(full(0), 2)), answer(page(full(1), 2)));
    const r = await zones(checking, two.deps);
    expect(r).toMatchObject({ ok: true, more: false });
    expect(r.ok && r.accounts).toHaveLength(100);
    expect(two.transport.mock.calls[1]![0]).toContain("page=2&");
    const many = deps(...[0, 1, 2, 3].map((n) => answer(page(full(n), 9))));
    const m = await zones(checking, many.deps);
    expect(m).toMatchObject({ ok: true, more: true });
    expect(m.ok && m.accounts).toHaveLength(MAX_ZONES);
    expect(many.transport).toHaveBeenCalledTimes(4);
  });

  it("tells a token Cloudflare refuses from one that may not list zones", async () => {
    expect(await zones(checking, deps(answer({ success: false, errors: [{ code: 1000, message: "Invalid API Token" }] }, 400)).deps)).toMatchObject({ ok: false, code: "token_refused" });
    expect(await zones(checking, deps(answer({ success: false, errors: [{ code: 6003, message: "Invalid request headers" }] }, 400)).deps)).toMatchObject({ code: "token_refused" });
    expect(await zones(checking, deps(answer({ success: false, errors: [] }, 401)).deps)).toMatchObject({ code: "token_refused" });
    // Fine, but without Zone Read: the Zone ID is typed instead.
    expect(await zones(checking, deps(answer({ success: false, errors: [{ code: 9109, message: "Unauthorized to access requested resource" }] }, 403)).deps)).toMatchObject({ code: "account_refused" });
    expect(await zones(checking, deps(answer({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, 403)).deps)).toMatchObject({ code: "account_refused" });
    expect(await zones(checking, deps(answer(page([]))).deps)).toEqual({ ok: true, accounts: [], more: false });
    expect(await zones(checking, deps(answer({}, 503)).deps)).toMatchObject({ code: "provider_error" });
    expect(await zones(checking, deps(answer({ success: false, errors: [] }, 429)).deps)).toMatchObject({ code: "rate_limited" });
  });

  it("drops a zone that isn't one, and refuses an answer that isn't a list", () => {
    expect(zonePage(page([zone("nope", "x.example"), { id: ZONE }, zone(ZONE, "acme.example")]))).toEqual({ zones: [{ id: ZONE, label: "acme.example", detail: null }], pages: 1 });
    expect(zonePage({ success: false, result: [] })).toBeNull();
    expect(zonePage({ success: true })).toBeNull();
  });
});

describe("Cloudflare zoneDaily", () => {
  const query = { stream: "zone_daily", from: "2026-11-19", to: "2026-11-20", by: "day" as const, limit: 100 };
  const settings = (s: Record<string, unknown> = { enabled: true, notOlderThan: 2678400, maxDuration: 2592000 }) =>
    answer({ data: { viewer: { zones: [{ settings: { httpRequestsAdaptiveGroups: s } }] } }, errors: null });
  const zone = {
    daily: [
      { dimensions: { date: "2026-11-20" }, sum: { requests: 2400, pageViews: 310 }, uniq: { uniques: 95 } },
      { dimensions: { date: "2026-11-19" }, sum: { requests: 2000, pageViews: 290 }, uniq: { uniques: 80 } },
    ],
    traffic: [
      { dimensions: { date: "2026-11-19" }, count: 1500, sum: { visits: 120 } },
      { dimensions: { date: "2026-11-20" }, count: 1700, sum: { visits: 140 } },
    ],
    pages: [
      { dimensions: { date: "2026-11-19" }, count: 250 },
      { dimensions: { date: "2026-11-20" }, count: 270 },
    ],
    // One group each for the whole period, as the dashboard's totals.
    total: [{ uniq: { uniques: 150 } }],
    trafficTotal: [{ count: 3200, sum: { visits: 260 } }],
    pagesTotal: [{ count: 520 }],
  };
  const data = (z: unknown, errors: unknown = null) => answer({ data: { viewer: { zones: [z] } }, errors });

  it("reads end users only, as the Traffic tab: requests, HTML page views and visits, with unique visitors from the daily totals", async () => {
    const { transport, deps: d } = deps(settings(), data(zone));
    const r = await zoneDaily({ ...input, query: { ...query, to: "2026-11-19" }, today: "2026-11-21" }, d);
    expect(r).toEqual({
      ok: true,
      rows: [{ day: "2026-11-19", cfRequests: 1500, cfPageViews: 250, cfVisits: 120, cfUniqueVisitors: 80 }],
      notes: [],
      period: { from: "2026-11-19", to: "2026-11-19", timeZone: "UTC", finalThrough: "2026-11-19" },
      totals: { cfUniqueVisitors: 150, cfRequests: 3200, cfPageViews: 520, cfVisits: 260 },
      more: false,
    });
    expect(sentBody(transport, 0).query).toContain("settings {\n        httpRequestsAdaptiveGroups { enabled notOlderThan maxDuration }");
    const body = sentBody(transport, 1);
    expect(body.variables).toEqual({ zoneTag: ZONE, from: "2026-11-19", to: "2026-11-19", afrom: "2026-11-19", ato: "2026-11-19" });
    // Every adaptive part (the days and their totals) is filtered to end users; page views are successful HTML responses.
    expect(body.query.match(/httpRequestsAdaptiveGroups\(/g)).toHaveLength(4);
    expect(body.query.match(/requestSource: "eyeball"/g)).toHaveLength(4);
    expect(body.query).toContain('edgeResponseContentTypeName: "html", edgeResponseStatus_geq: 200, edgeResponseStatus_lt: 300');
    expect(body.query).toContain("uniq { uniques }");
    expect(body.query).toContain("httpRequests1dGroups(limit: 1,");
    expect(body.query).not.toContain(ZONE);
    // The period's totals: the same datasets with no dimensions, one group each.
    expect(body.query).toContain("total: httpRequests1dGroups(limit: 1, filter: { date_geq: $from, date_leq: $to }) {\n        uniq { uniques }\n      }");
    expect(body.query).toMatch(/trafficTotal: httpRequestsAdaptiveGroups\(limit: 1, filter: \{ date_geq: \$afrom, date_leq: \$ato, requestSource: "eyeball" \}\) \{\s+count\s+sum \{ visits \}/);
    expect(body.query).toMatch(/pagesTotal: httpRequestsAdaptiveGroups\(limit: 1, filter: \{ [^}]*requestSource: "eyeball", edgeResponseContentTypeName: "html"/);
  });

  it("gives unique visitors for the whole period, which daily visitors can't be added up to", async () => {
    const r = await zoneDaily({ ...input, query: { ...query, from: undefined, to: undefined, period: "last_28_days" as const }, today: "2026-11-21" }, deps(settings(), data(zone)).deps);
    expect(r.ok && r.totals?.cfUniqueVisitors).toBe(150);
    expect(r.ok && r.rows.reduce((n, x) => n + Number(x.cfUniqueVisitors), 0)).toBe(175);
  });

  it("counts yesterday as not yet final, as the Free plan's note says it may be low", async () => {
    const r = await zoneDaily({ ...input, query, today: "2026-11-21" }, deps(settings(), data(zone)).deps);
    expect(r).toMatchObject({ ok: true, period: { to: "2026-11-20", finalThrough: "2026-11-19" } });
  });

  it("notes the Free plan's day of delay when the read reaches yesterday", async () => {
    const r = await zoneDaily({ ...input, query, today: "2026-11-21" }, deps(settings(), data(zone)).deps);
    expect(r.ok && r.rows.map((x) => x.cfRequests)).toEqual([1500, 1700]);
    expect(r.ok && r.notes).toEqual([freePlanNote("2026-11-20")]);
    expect(freePlanNote("2026-11-20")).toBe("On Cloudflare's Free plan numbers arrive 24 hours late, so if this zone is on it, 20 Nov may be low.");
  });

  it("reads days the zone keeps no end user numbers for from the daily totals, naming them, and visits only within its retention", async () => {
    // 90 days on 21 Nov: the zone keeps 31 days, so end users from 22 Oct (30 days at once), all traffic before.
    const daily = [
      { dimensions: { date: "2026-08-23" }, sum: { requests: 900, pageViews: 100 }, uniq: { uniques: 40 } },
      { dimensions: { date: "2026-11-20" }, sum: { requests: 2400, pageViews: 310 }, uniq: { uniques: 95 } },
    ];
    const { transport, deps: d } = deps(settings(), data({ daily, traffic: [zone.traffic[1]], pages: [zone.pages[1]], total: [{ uniq: { uniques: 600 } }] }));
    const r = await zoneDaily({ ...input, query: { ...query, from: undefined, to: undefined, period: "last_90_days" as const }, today: "2026-11-21" }, d);
    expect(sentBody(transport, 1).variables).toEqual({ zoneTag: ZONE, from: "2026-08-23", to: "2026-11-20", afrom: "2026-10-22", ato: "2026-11-20" });
    expect(sentBody(transport, 1).query).toContain("httpRequests1dGroups(limit: 90,");
    expect(r).toMatchObject({
      ok: true,
      rows: [
        { day: "2026-08-23", cfRequests: 900, cfPageViews: 100, cfVisits: null, cfUniqueVisitors: 40 },
        { day: "2026-11-20", cfRequests: 1700, cfPageViews: 270, cfVisits: 140, cfUniqueVisitors: 95 },
      ],
      period: { from: "2026-08-23", to: "2026-11-20" },
    });
    // Days of two kinds: only unique visitors get a period total, and the end user totals aren't asked for.
    expect(r.ok && r.totals).toEqual({ cfUniqueVisitors: 600 });
    expect(sentBody(transport, 1).query).not.toContain("trafficTotal");
    expect(r.ok && r.notes[0]).toBe(olderDaysNote("2026-08-23", "2026-10-21"));
    expect(r.ok && r.notes[0]).toBe(
      "Cloudflare keeps end user numbers only for recent days, so for 23 Aug to 21 Oct requests and page views count all traffic, bots included, and visits are empty.",
    );
  });

  it("works the adaptive reach out from the zone's settings, or Cloudflare's documented floor", () => {
    const now = new Date("2026-11-21T10:00:00Z");
    expect(adaptiveFrom(now, "2026-08-23", "2026-11-20", { notOlderThan: 2678400, maxDuration: 2592000 })).toBe("2026-10-22");
    // A plan that keeps 90 days but reads 7 at once.
    expect(adaptiveFrom(now, "2026-08-23", "2026-11-20", { notOlderThan: 90 * 86400, maxDuration: 7 * 86400 })).toBe("2026-11-14");
    expect(adaptiveFrom(now, "2026-11-19", "2026-11-20", ADAPTIVE_DEFAULTS)).toBe("2026-11-19");
    expect(adaptiveSettings({ data: { viewer: { zones: [{ settings: { httpRequestsAdaptiveGroups: { enabled: false, notOlderThan: 86400 } } }] } } })).toEqual({
      enabled: false,
      notOlderThan: 86400,
      maxDuration: ADAPTIVE_DEFAULTS.maxDuration,
    });
    expect(adaptiveSettings({})).toEqual({ enabled: true, ...ADAPTIVE_DEFAULTS });
  });

  it("asks only the daily totals when no day is within the zone's retention, or its settings say it can't read end users", async () => {
    const off = deps(settings({ enabled: false }), data({ daily: zone.daily }));
    const r = await zoneDaily({ ...input, query, today: "2026-11-21" }, off.deps);
    expect(sentBody(off.transport, 1).query).not.toContain("httpRequestsAdaptiveGroups");
    expect(sentBody(off.transport, 1).variables).toEqual({ zoneTag: ZONE, from: "2026-11-19", to: "2026-11-20" });
    expect(r).toMatchObject({ ok: true, rows: [{ cfRequests: 2000, cfVisits: null }, { cfRequests: 2400, cfVisits: null }] });
    expect(r.ok && r.notes[0]).toBe(END_USERS_NOTE);
    // Explicit days all older than the zone keeps end user numbers for.
    const old = deps(settings(), data({ daily: zone.daily }));
    const o = await zoneDaily({ ...input, query: { ...query, from: "2026-09-01", to: "2026-09-02" }, today: "2026-11-21" }, old.deps);
    expect(sentBody(old.transport, 1).query).not.toContain("httpRequestsAdaptiveGroups");
    expect(o.ok && o.notes[0]).toBe(olderDaysNote("2026-09-01", "2026-09-02"));
  });

  it("keeps the days with a note when only the period's totals fail", async () => {
    const failed = data({ ...zone, total: null, trafficTotal: null }, [
      { message: "query consumed excessive resources", path: ["viewer", "zones", 0, "total"] },
      { message: "query consumed excessive resources", path: ["viewer", "zones", 0, "trafficTotal"] },
    ]);
    const r = await zoneDaily({ ...input, query, today: "2026-11-21" }, deps(settings(), failed).deps);
    expect(r).toMatchObject({ ok: true, rows: [{ cfRequests: 1500 }, { cfRequests: 1700 }] });
    expect(r.ok && r.totals).toBeUndefined();
    expect(r.ok && r.notes.at(-1)).toBe(NO_TOTALS_NOTE);
  });

  it("keeps the daily totals when only the end user part fails, with a note", async () => {
    const failed = data({ daily: zone.daily, traffic: null, pages: null }, [{ message: "cannot request data older than 2678400s", path: ["viewer", "zones", 0, "traffic"] }]);
    const r = await zoneDaily({ ...input, query, today: "2026-11-21" }, deps(settings(), failed).deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows.map((x) => [x.cfRequests, x.cfVisits])).toEqual([
      [2000, null],
      [2400, null],
    ]);
    expect(r.notes[0]).toBe(END_USERS_NOTE);
  });

  it("falls back to Cloudflare's documented reach when the settings can't be read, but stops on a token it turns down", async () => {
    for (const refused of [answer({ data: null, errors: [{ message: "unknown field settings" }] }), answer({ errors: [{ message: "invalid query" }] }, 400)]) {
      const { transport, deps: d } = deps(refused, data(zone));
      const r = await zoneDaily({ ...input, query, today: "2026-11-21" }, d);
      expect(r.ok).toBe(true);
      expect(sentBody(transport, 1).variables).toMatchObject({ afrom: "2026-11-19", ato: "2026-11-20" });
    }
    const stopped = deps(answer({ errors: [{ message: "Unauthorized" }] }, 401));
    expect(await zoneDaily({ ...input, query, today: "2026-11-21" }, stopped.deps)).toMatchObject({ ok: false, code: "token_refused" });
    expect(stopped.transport).toHaveBeenCalledTimes(1);
  });

  it("caps a read at yesterday in UTC with a dated note, and reads nothing for today alone", async () => {
    const { transport, deps: d } = deps(settings(), data(zone));
    const r = await zoneDaily({ ...input, query: { ...query, to: "2026-11-21" }, today: "2026-11-21" }, d);
    expect(sentBody(transport, 1).variables).toMatchObject({ from: "2026-11-19", to: "2026-11-20" });
    expect(r.ok && r.notes[0]).toBe("The last complete day in Cloudflare is 20 Nov, so this read ends there.");
    const today = deps();
    expect(await zoneDaily({ ...input, query: { ...query, from: "2026-11-21", to: "2026-11-21" }, today: "2026-11-21" }, today.deps)).toMatchObject({ ok: true, rows: [] });
    expect(today.transport).not.toHaveBeenCalled();
  });

  it("fails when the daily totals fail, and refuses a stream or grouping it doesn't know", async () => {
    const totalsFailed = answer({ data: null, errors: [{ message: "cannot request data older than 31536000s", path: ["viewer", "zones", 0, "daily"] }] });
    expect(await zoneDaily({ ...input, query, today: "2026-11-21" }, deps(settings(), totalsFailed).deps)).toMatchObject({ ok: false, code: "query_refused" });
    const { transport, deps: d } = deps();
    expect(await zoneDaily({ ...input, query: { ...query, by: "page" }, today: "2026-11-21" }, d)).toMatchObject({ ok: false, code: "query_refused" });
    expect(transport).not.toHaveBeenCalled();
    expect(await zoneDaily({ ...input, query, today: "2026-11-21" }, deps(answer({ errors: [{ message: "Unauthorized" }] }, 401)).deps)).toMatchObject({ ok: false, code: "token_refused" });
  });

  it("drops a row with a bad date and a number that isn't a count", async () => {
    const odd = {
      daily: [
        { dimensions: { date: "yesterday" }, sum: { requests: 1 } },
        { dimensions: { date: "2026-11-20" }, sum: { requests: -4, pageViews: "lots" }, uniq: { uniques: 1.5 } },
      ],
      traffic: [{ dimensions: { date: "2026-11-20" }, count: "many", sum: { visits: -1 } }],
      pages: [],
    };
    const r = await zoneDaily({ ...input, query, today: "2026-11-21" }, deps(settings(), data(odd)).deps);
    expect(r.ok && r.rows).toEqual([{ day: "2026-11-20", cfRequests: null, cfPageViews: 0, cfVisits: null, cfUniqueVisitors: 2 }]);
    // A recent day the end user part lists nothing for has no number yet, rather than a 0.
    const late = { daily: zone.daily, traffic: [zone.traffic[0]], pages: [] };
    const l = await zoneDaily({ ...input, query, today: "2026-11-21" }, deps(settings(), data(late)).deps);
    expect(l.ok && l.rows).toEqual([
      { day: "2026-11-19", cfRequests: 1500, cfPageViews: 0, cfVisits: 120, cfUniqueVisitors: 80 },
      { day: "2026-11-20", cfRequests: null, cfPageViews: null, cfVisits: null, cfUniqueVisitors: 95 },
    ]);
  });

  it("dates its notes in house style", () => {
    for (const t of [olderDaysNote("2026-08-23", "2026-10-21"), END_USERS_NOTE, freePlanNote("2026-11-20"), NO_TOTALS_NOTE]) {
      expect(dashesIn(t), t).toEqual([]);
      expect(aiTellsIn(t), t).toEqual([]);
    }
  });

  it("classifies Cloudflare's documented error messages", () => {
    expect(classifyErrors([{ message: "Unauthorized" }])).toBe("token_refused");
    expect(classifyErrors([{ message: "does not have access to the path" }])).toBe("account_refused");
    expect(classifyErrors([{ message: "query consumed excessive resources" }])).toBe("rate_limited");
    expect(classifyErrors([{ message: "cannot request data older than 86400s" }])).toBe("query_refused");
    expect(classifyErrors([{ message: "something else" }])).toBe("provider_error");
  });
});
