import { describe, expect, it, vi } from "vitest";
import { parseManifest } from "../manifest";
import { cloudflareManifest } from "../manifests/cloudflare";
import { allConnectors } from "../registry";
import { classifyErrors, zoneDaily, zoneProbe } from "./cloudflare";
import { LIVE_HOOKS, VERIFY_HOOKS } from "./index";

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

describe("Cloudflare zoneDaily", () => {
  const query = { stream: "zone_daily", from: "2026-11-19", to: "2026-11-20", by: "day" as const, limit: 100 };
  const zone = {
    totals: [
      { dimensions: { date: "2026-11-20" }, sum: { requests: 2400, pageViews: 310 } },
      { dimensions: { date: "2026-11-19" }, sum: { requests: 2000, pageViews: 290 } },
    ],
    visits: [
      { dimensions: { date: "2026-11-19" }, sum: { visits: 120 } },
      { dimensions: { date: "2026-11-20" }, sum: { visits: 140 } },
    ],
  };

  it("joins daily totals and visits by day, oldest first", async () => {
    const { transport, deps: d } = deps(answer({ data: { viewer: { zones: [zone] } }, errors: null }));
    const r = await zoneDaily({ ...input, query, today: "2026-11-21" }, d);
    expect(r).toEqual({
      ok: true,
      rows: [
        { day: "2026-11-19", cfRequests: 2000, cfPageViews: 290, cfVisits: 120 },
        { day: "2026-11-20", cfRequests: 2400, cfPageViews: 310, cfVisits: 140 },
      ],
      notes: [],
    });
    const body = sentBody(transport);
    expect(body.variables).toEqual({ zoneTag: ZONE, from: "2026-11-19", to: "2026-11-20" });
    expect(body.query).toContain("httpRequests1dGroups(limit: 100");
    expect(body.query).toContain("httpRequestsAdaptiveGroups(limit: 100");
    expect(body.query).toContain("sum { visits }");
  });

  it("keeps the totals when only the visits part fails, with a note", async () => {
    const r = await zoneDaily(
      { ...input, query: { ...query, to: "2026-11-21" }, today: "2026-11-21" },
      deps(answer({ data: { viewer: { zones: [{ totals: zone.totals, visits: null }] } }, errors: [{ message: "cannot request data older than 2678400s", path: ["viewer", "zones", 0, "visits"] }] })).deps,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows.map((x) => x.cfVisits)).toEqual([null, null]);
    expect(r.notes).toEqual(["Visits aren't available for these days: Cloudflare keeps them for about a month.", "Today's numbers are still coming in."]);
  });

  it("fails when the totals fail, and refuses a stream or grouping it doesn't know", async () => {
    const totalsFailed = { data: null, errors: [{ message: "cannot request data older than 31536000s", path: ["viewer", "zones", 0, "totals"] }] };
    expect(await zoneDaily({ ...input, query, today: "2026-11-21" }, deps(answer(totalsFailed)).deps)).toMatchObject({ ok: false, code: "query_refused" });
    const { transport, deps: d } = deps();
    expect(await zoneDaily({ ...input, query: { ...query, by: "page" }, today: "2026-11-21" }, d)).toMatchObject({ ok: false, code: "query_refused" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("drops a row with a bad date and a number that isn't a count", async () => {
    const odd = { totals: [{ dimensions: { date: "yesterday" }, sum: { requests: 1 } }, { dimensions: { date: "2026-11-20" }, sum: { requests: -4, pageViews: "lots" } }], visits: [] };
    const r = await zoneDaily({ ...input, query, today: "2026-11-21" }, deps(answer({ data: { viewer: { zones: [odd] } } })).deps);
    expect(r).toEqual({ ok: true, rows: [{ day: "2026-11-20", cfRequests: null, cfPageViews: null, cfVisits: null }], notes: [] });
  });

  it("classifies Cloudflare's documented error messages", () => {
    expect(classifyErrors([{ message: "Unauthorized" }])).toBe("token_refused");
    expect(classifyErrors([{ message: "does not have access to the path" }])).toBe("account_refused");
    expect(classifyErrors([{ message: "query consumed excessive resources" }])).toBe("rate_limited");
    expect(classifyErrors([{ message: "cannot request data older than 86400s" }])).toBe("query_refused");
    expect(classifyErrors([{ message: "something else" }])).toBe("provider_error");
  });
});
