import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isRateLimited, type RateLimitConfig } from "@/lib/tenant";
import { __resetRateLimitState } from "@/lib/tenant/rateLimit";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { parseManifest } from "./manifest";
import { cloudflareManifest } from "./manifests/cloudflare";
import { connectorFetch, declaredUrl, type ConnectorCall } from "./safeFetch";

// No test reaches the network: the global fetch that src/lib/security/ssrf.ts calls is a stub,
// so the real redirect handling runs and no DNS lookup or socket ever happens.
const manifest = parseManifest(cloudflareManifest);
const TOKEN = "made-up-cloudflare-token-0000000000";
const GRAPHQL = "https://api.cloudflare.com/client/v4/graphql";
const health = { state: "ok" as const, lastOkAt: null, lastCheckedAt: null, lastErrorCode: null, failures: 0, pausedUntil: null };
const connection = { id: "dcn_aaaaaaaaaaaaaaaaaaaa", tenantId: "ten_a", pausedAt: null, health };
const call = (over: Partial<ConnectorCall> = {}): ConnectorCall => ({ manifest, connection, url: GRAPHQL, method: "POST", json: { query: "{ viewer { zones { zoneTag } } }" }, token: TOKEN, ...over });

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

let fetchMock: ReturnType<typeof vi.fn>;
let logs: string[];
const noLimit = vi.fn(async () => false);
const deps = () => ({ limit: noLimit, log: (l: string) => logs.push(l) });

beforeEach(() => {
  fetchMock = vi.fn(async () => json(200, { data: { ok: true }, errors: null }));
  vi.stubGlobal("fetch", fetchMock);
  logs = [];
  noLimit.mockClear();
  __resetRateLimitState();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("connectorFetch", () => {
  it("sends the token once to a declared host and reads the JSON", async () => {
    const r = await connectorFetch(call(), deps());
    expect(r).toEqual({ ok: true, status: 200, body: { data: { ok: true }, errors: null } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(GRAPHQL);
    expect((init as RequestInit).redirect).toBe("manual");
    expect(((init as RequestInit).headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("refuses an undeclared host, http, another port and credentials before any request", async () => {
    for (const url of ["https://evil.example/graphql", "http://api.cloudflare.com/client/v4/graphql", "https://api.cloudflare.com:8443/x", "https://user:pw@api.cloudflare.com/x", "https://api.cloudflare.com.evil.example/x"]) {
      const r = await connectorFetch(call({ url }), deps());
      expect(r).toMatchObject({ ok: false, code: "host_not_allowed" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(noLimit).not.toHaveBeenCalled();
    expect(declaredUrl("https://api.cloudflare.com:443/x", ["api.cloudflare.com"])?.hostname).toBe("api.cloudflare.com");
  });

  it("throws away a 302, even to a declared host, after exactly one request", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://api.cloudflare.com/elsewhere" } }));
    const r = await connectorFetch(call(), deps());
    expect(r).toMatchObject({ ok: false, code: "redirect_refused" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValue(new Response(null, { status: 307 }));
    expect(await connectorFetch(call(), deps())).toMatchObject({ ok: false, code: "redirect_refused", status: 307 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refuses a paused connection before any request", async () => {
    const now = new Date("2026-11-21T10:00:00Z");
    expect(await connectorFetch(call({ connection: { ...connection, pausedAt: "2026-11-21T09:00:00.000Z" } }), { ...deps(), now })).toMatchObject({ code: "paused" });
    const autoPaused = { ...connection, health: { ...health, state: "paused" as const, pausedUntil: "2026-11-21T10:15:00.000Z" } };
    expect(await connectorFetch(call({ connection: autoPaused }), { ...deps(), now })).toMatchObject({ code: "paused" });
    expect(fetchMock).not.toHaveBeenCalled();
    const over = { ...autoPaused, health: { ...autoPaused.health, pausedUntil: "2026-11-21T09:59:00.000Z" } };
    expect((await connectorFetch(call({ connection: over }), { ...deps(), now })).ok).toBe(true);
  });

  it("limits per connection and per brand for this connector, and refuses when either is over", async () => {
    const seen: Array<[string, RateLimitConfig]> = [];
    const limit = vi.fn(async (subject: string, config: RateLimitConfig) => (seen.push([subject, config]), false));
    await connectorFetch(call(), { limit, log: () => {} });
    expect(seen).toEqual([
      ["ten_a:dcn_aaaaaaaaaaaaaaaaaaaa", { prefix: "connector-conn:cloudflare", burstLimit: 10, hourlyLimit: 120 }],
      ["ten_a", { prefix: "connector-brand:cloudflare", burstLimit: 20, hourlyLimit: 300 }],
    ]);
    limit.mockImplementation(async (_s, config) => config.prefix.startsWith("connector-brand"));
    expect(await connectorFetch(call(), { limit, log: () => {} })).toMatchObject({ ok: false, code: "busy" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("counts against the shared limiter: one brand's busy connector doesn't hold up another brand", async () => {
    const db = new FakeFirestore();
    const limit = (s: string, c: RateLimitConfig) => isRateLimited(s, c, { db });
    const small = { ...manifest, api: { ...manifest.api, limits: { connection: { perMinute: 5, perHour: 50 }, brand: { perMinute: 2, perHour: 50 } } } };
    const other = { ...connection, id: "dcn_bbbbbbbbbbbbbbbbbbbb" };
    expect((await connectorFetch(call({ manifest: small }), { limit, log: () => {} })).ok).toBe(true);
    expect((await connectorFetch(call({ manifest: small, connection: other }), { limit, log: () => {} })).ok).toBe(true);
    expect(await connectorFetch(call({ manifest: small, connection: other }), { limit, log: () => {} })).toMatchObject({ code: "busy" });
    expect((await connectorFetch(call({ manifest: small, connection: { ...connection, tenantId: "ten_b" } }), { limit, log: () => {} })).ok).toBe(true);
    expect(db.dump("rate_limits").map((d) => d.prefix).sort()).toEqual([
      "connector-brand:cloudflare",
      "connector-brand:cloudflare",
      "connector-conn:cloudflare",
      "connector-conn:cloudflare",
      "connector-conn:cloudflare",
    ]);
  });

  it("maps statuses, a Retry-After, an oversized body, bad JSON and a timeout to codes", async () => {
    fetchMock.mockResolvedValueOnce(json(401, { errors: [{ message: "Unauthorized" }] }));
    expect(await connectorFetch(call(), deps())).toMatchObject({ ok: false, code: "token_refused", status: 401, body: { errors: [{ message: "Unauthorized" }] } });
    fetchMock.mockResolvedValueOnce(json(429, {}, { "retry-after": "120" }));
    expect(await connectorFetch(call(), deps())).toMatchObject({ code: "rate_limited", retryAfterSec: 120 });
    fetchMock.mockResolvedValueOnce(json(503, {}));
    expect(await connectorFetch(call(), deps())).toMatchObject({ code: "provider_error" });
    fetchMock.mockResolvedValueOnce(json(400, { errors: [{ message: "cannot request data older than 31 days" }] }));
    expect(await connectorFetch(call(), deps())).toMatchObject({ code: "query_refused", status: 400 });
    fetchMock.mockResolvedValueOnce(new Response("x".repeat(manifest.api.maxBytes + 10), { status: 200 }));
    expect(await connectorFetch(call(), deps())).toMatchObject({ code: "body_too_large" });
    fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 200 }));
    expect(await connectorFetch(call(), deps())).toMatchObject({ code: "bad_response" });
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
    expect(await connectorFetch(call(), deps())).toMatchObject({ code: "bad_response" });
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));
    expect(await connectorFetch(call(), deps())).toMatchObject({ code: "timeout" });
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await connectorFetch(call(), deps())).toMatchObject({ code: "network" });
  });

  it("logs the host and the code only, never the token, path or body", async () => {
    fetchMock.mockResolvedValueOnce(json(401, { errors: [{ message: "Unauthorized" }] }));
    await connectorFetch(call({ url: `${GRAPHQL}?zone=secret-zone` }), deps());
    expect(logs).toEqual(["[connectors] cloudflare api.cloudflare.com token_refused 401"]);
    expect(logs.join()).not.toContain(TOKEN);
  });
});

describe("the third bucket, per organisation connection (Connectors 3)", () => {
  it("counts a part's calls in its organisation connection's budget, and a brand's own connection's not", async () => {
    const seen: Array<[string, RateLimitConfig]> = [];
    const limit = async (subject: string, config: RateLimitConfig) => {
      seen.push([subject, config]);
      return false;
    };
    await connectorFetch(call({ connection: { ...connection, source: { organisationId: "org_ten_a", connectionId: "ocn_aaaaaaaaaaaaaaaaaaaa" } } }), { limit, log: () => {} });
    expect(seen.map(([s, c]) => `${c.prefix} ${s}`)).toEqual(["connector-conn:cloudflare ten_a:dcn_aaaaaaaaaaaaaaaaaaaa", "connector-brand:cloudflare ten_a", "connector-src:cloudflare org_ten_a:ocn_aaaaaaaaaaaaaaaaaaaa"]);
    expect(seen[2]![1]).toMatchObject({ burstLimit: 40, hourlyLimit: 600 });
    seen.length = 0;
    await connectorFetch(call(), { limit, log: () => {} });
    expect(seen.map(([, c]) => c.prefix)).not.toContain("connector-src:cloudflare");
  });

  it("refuses as busy, before any request, once the organisation connection's budget is spent", async () => {
    const limit = async (_subject: string, config: RateLimitConfig) => config.prefix.startsWith("connector-src:");
    const r = await connectorFetch(call({ connection: { ...connection, source: { organisationId: "org_ten_a", connectionId: "ocn_aaaaaaaaaaaaaaaaaaaa" } } }), { limit, log: () => {} });
    expect(r).toMatchObject({ ok: false, code: "busy" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

