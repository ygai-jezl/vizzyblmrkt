import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { MEANINGS } from "@/lib/metrics/meanings";
import { collectedStream, ConnectorManifestSchema, MCP_HOOKS, mcpMethod, oauthMethod, parseManifest, pastedFieldsOf, PLATFORM_SWITCHES, RESERVED_CONNECTOR_IDS, shareMethod, streamOf, tokenMethod, type ConnectorManifestInput } from "./manifest";
import { cloudflareManifest } from "./manifests/cloudflare";
import { ga4Manifest } from "./manifests/ga4";
import { searchConsoleManifest } from "./manifests/searchConsole";
import { MANIFESTS } from "./registry";
import { testMcpManifest } from "./testing/mcpServer";

/** Every string anywhere in a value, for the house style check. */
function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) stringsIn(v, out);
  return out;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const base = (): ConnectorManifestInput => clone(cloudflareManifest);
const issues = (m: unknown) => {
  const r = ConnectorManifestSchema.safeParse(m);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("connector manifests", () => {
  it.each(MANIFESTS.map((m) => [(m as { id: string }).id, m]))("%s parses", (_id, m) => {
    expect(issues(m)).toEqual([]);
  });

  it.each(MANIFESTS.map((m) => [(m as { id: string }).id, m]))("%s is pure data: a JSON round trip changes nothing", (_id, m) => {
    expect(clone(m)).toEqual(m);
    expect(parseManifest(clone(m))).toEqual(parseManifest(m));
  });

  it.each(MANIFESTS.map((m) => [(m as { id: string }).id, m]))("%s names only meanings that exist", (_id, m) => {
    for (const p of parseManifest(m).produces) for (const k of p.measures) expect(Object.keys(MEANINGS), k).toContain(k);
  });

  it.each(MANIFESTS.map((m) => [(m as { id: string }).id, m]))("%s calls only bare https hosts", (_id, m) => {
    const parsed = parseManifest(m);
    for (const h of parsed.api.hosts) expect(h).toMatch(/^[a-z0-9.-]+$/);
    expect(parsed.api.hosts).toContain(new URL(parsed.verify.url).hostname);
  });

  it.each(MANIFESTS.map((m) => [(m as { id: string }).id, m]))("%s writes in house style", (_id, m) => {
    for (const text of stringsIn(m).filter((s) => !/^https:\/\//.test(s) && !s.startsWith("^"))) {
      expect(dashesIn(text), text).toEqual([]);
      expect(aiTellsIn(text), text).toEqual([]);
    }
  });

  it("refuses the reserved ids, a bad id and a hook named for another connector", () => {
    for (const id of RESERVED_CONNECTOR_IDS) expect(issues({ ...base(), id }).join()).toContain("reserved");
    expect(issues({ ...base(), id: "Cloud Flare" }).length).toBeGreaterThan(0);
    expect(issues({ ...base(), hooks: { live: "github.zoneDaily" } }).join()).toContain("connector's own name");
  });

  it("refuses the platform's own switches, as a connector's switch or a sign in method's", () => {
    for (const name of PLATFORM_SWITCHES) {
      expect(issues({ ...base(), switch: name }).join()).toContain("platform switch");
      const ga4 = clone(ga4Manifest) as ConnectorManifestInput;
      const signIn = { ...ga4.connect[0]!, switch: name };
      expect(issues({ ...ga4, connect: [signIn, ...ga4.connect.slice(1)] }).join()).toContain("platform switch");
    }
    expect(RESERVED_CONNECTOR_IDS).toContain("signals");
  });

  it("collects at most one stream, through its own collect hook, by groupings it can read, for at most 90 days", () => {
    for (const m of MANIFESTS) {
      const parsed = parseManifest(m);
      const stream = collectedStream(parsed)!;
      expect(stream.collect.keepDays).toBe(90);
      expect(stream.collect.rowsPerDay).toBe(500);
      expect(parsed.hooks.collect).toBeDefined();
    }
    const m = base();
    const stream = m.produces[0]!;
    expect(issues({ ...m, hooks: { live: m.hooks.live, accounts: m.hooks.accounts } }).join()).toContain("needs hooks.collect");
    expect(issues({ ...m, produces: [{ ...stream, collect: undefined }] }).join()).toContain("hooks.collect needs a stream");
    expect(issues({ ...m, produces: [{ ...stream, collect: { ...stream.collect!, by: ["page"] } }] }).join()).toContain("not one of its liveBy");
    expect(issues({ ...m, produces: [{ ...stream, collect: { ...stream.collect!, keepDays: 120 } }] }).length).toBeGreaterThan(0);
    expect(issues({ ...m, produces: [stream, { ...stream, stream: "zone_other" }] }).join()).toContain("at most one stream is collected");
    expect(issues({ ...m, hooks: { ...m.hooks, collect: "github.collectDays" } }).join()).toContain("connector's own name");
  });

  it("refuses an undeclared verify host, a host with a scheme or port, and an http link", () => {
    expect(issues({ ...base(), verify: { ...base().verify, url: "https://evil.example/graphql" } }).join()).toContain("declared host");
    const api = base().api;
    expect(issues({ ...base(), api: { ...api, hosts: ["https://api.cloudflare.com"] } }).length).toBeGreaterThan(0);
    expect(issues({ ...base(), api: { ...api, hosts: ["api.cloudflare.com:8443"] } }).length).toBeGreaterThan(0);
    expect(issues({ ...base(), verify: { ...base().verify, url: "http://api.cloudflare.com/client/v4/graphql" } }).length).toBeGreaterThan(0);
    expect(issues({ ...base(), verify: { ...base().verify, url: "https://api.cloudflare.com:444/x" } }).length).toBeGreaterThan(0);
  });

  it("refuses a measure with no meaning, a numbers stream with none, and a liveBy with no key", () => {
    const m = base();
    const stream = m.produces[0]!;
    expect(issues({ ...m, produces: [{ ...stream, measures: ["cfNope"] }] }).join()).toContain("meanings.ts");
    expect(issues({ ...m, produces: [{ ...stream, measures: [] }] }).join()).toContain("at least one measure");
    expect(issues({ ...m, produces: [{ ...stream, liveBy: ["page"] }] }).join()).toContain("no key that joins");
    expect(issues({ ...m, produces: [{ ...stream, joins: { page: "page" } }] }).join()).toContain("not one of its keys");
  });

  it("joins a landing page on page, and refuses a page filter, or a time zone, it can't honour", () => {
    const m = base();
    const stream = m.produces[0]!;
    const landing = { ...stream, keys: ["day", "landing"], joins: { day: "day" as const, landing: "page" as const }, liveBy: ["day" as const, "landing" as const] };
    expect(issues({ ...m, produces: [landing] })).toEqual([]);
    expect(issues({ ...m, produces: [{ ...stream, liveBy: ["landing"] }] }).join()).toContain("no key that joins");
    expect(issues({ ...m, produces: [{ ...stream, liveFilters: ["page"] }] }).join()).toContain("liveFilters page has no key");
    expect(issues({ ...m, produces: [{ ...landing, liveFilters: ["page"] }] })).toEqual([]);
    expect(issues({ ...m, produces: [{ ...stream, timeZone: "Mars/Olympus" }] }).join()).toContain("IANA time zone");
    expect(streamOf(parseManifest(searchConsoleManifest), "search_performance")).toMatchObject({ timeZone: "America/Los_Angeles", liveFilters: ["page"] });
  });

  it("refuses a permission or scope with no shares line, and shares with no Never line", () => {
    const m = base();
    expect(issues({ ...m, shares: m.shares.map((s) => ({ ...s, needs: [] })) }).join()).toContain("has no shares line");
    expect(issues({ ...m, shares: m.shares.filter((s) => s.direction !== "never") }).join()).toContain("never read or written");
  });

  it("refuses functions, a secret account field and a public auth field", () => {
    expect(issues({ ...base(), hooks: { live: () => null } }).length).toBeGreaterThan(0);
    const m = base();
    const method = m.connect[0] as Extract<ConnectorManifestInput["connect"][number], { method: "token_fields" }>;
    expect(issues({ ...m, connect: [{ ...method, account: "token" }] }).join()).toContain("account must name");
    expect(issues({ ...m, connect: [{ ...method, auth: { field: "zoneId", scheme: "Bearer" } }] }).join()).toContain("auth.field");
    const extra = { key: "note", label: "Note", secret: false, pattern: "^.+$", minLength: 1, maxLength: 20 };
    expect(issues({ ...m, connect: [{ ...method, fields: [...method.fields, extra] }] }).join()).toContain("neither the account nor a secret");
    expect(issues({ ...m, connect: [{ ...method, fields: method.fields.map((f) => ({ ...f, pattern: "[a-z]+" })) }] }).length).toBeGreaterThan(0);
  });

  it("takes a tile's two letters only as two capitals or digits", () => {
    expect(parseManifest(cloudflareManifest).initials).toBe("CF");
    expect(parseManifest(searchConsoleManifest).initials).toBeUndefined();
    for (const bad of ["C", "cf", "CFX", "C-"]) expect(issues({ ...base(), initials: bad }).join(), bad).toContain("two capital letters or digits");
  });

  it("takes marks only as svg or png files in the connector's own folder on this site", () => {
    const icon = { light: "/marks/connectors/cloudflare/icon.png", owner: "Cloudflare, Inc." };
    expect(issues({ ...base(), icon })).toEqual([]);
    expect(issues({ ...base(), icon: { ...icon, dark: "/marks/connectors/cloudflare/icon-dark.svg" } })).toEqual([]);
    const bad = [
      "https://www.cloudflare.com/logo.png",
      "//cdn.example/x.png",
      "/marks/connectors/cloudflare/icon.gif",
      "/marks/connectors/cloudflare/../../secret.png",
      "/marks/connectors/cloudflare/sub/icon.png",
      "/marks/connectors/cloudflare/Icon.png",
      "/marks/connectors/cloudflare/icon.svg?x=1",
      "/brand/yougrow-mark.svg",
      "marks/connectors/cloudflare/icon.png",
    ];
    for (const light of bad) expect(issues({ ...base(), icon: { ...icon, light } }).length, light).toBeGreaterThan(0);
    // Another connector's folder, for any of its files.
    expect(issues({ ...base(), icon: { ...icon, light: "/marks/connectors/search-console/icon.png" } }).join()).toContain("not in the connector's own folder");
    const lockup = { light: "/marks/connectors/cloudflare/wide.png", href: "https://www.cloudflare.com/", alt: "Cloudflare", width: 189, height: 50 };
    expect(issues({ ...base(), icon: { ...icon, lockup } })).toEqual([]);
    expect(issues({ ...base(), icon: { ...icon, lockup: { ...lockup, dark: "/marks/connectors/ga/wide.png" } } }).join()).toContain("not in the connector's own folder");
    expect(issues({ ...base(), icon: { ...icon, lockup: { ...lockup, href: "http://www.cloudflare.com/" } } }).length).toBeGreaterThan(0);
    expect(issues({ ...base(), icon: { ...icon, lockup: { ...lockup, href: undefined } } }).length).toBeGreaterThan(0);
    // A mark names its owner, and nothing else rides along.
    expect(issues({ ...base(), icon: { light: icon.light } }).length).toBeGreaterThan(0);
    expect(issues({ ...base(), icon: { ...icon, svg: "<svg onload=alert(1)>" } }).length).toBeGreaterThan(0);
  });

  it("gives every built-in connector its marks, owned by Google, Cloudflare or Vizzybl, and keeps the letters as the fallback", () => {
    const icons = MANIFESTS.map((m) => parseManifest(m)).map((m) => [m.id, m.icon?.owner, m.icon?.light]);
    expect(icons).toEqual([
      ["search-console", "Google LLC", "/marks/connectors/search-console/icon.png"],
      ["google-analytics", "Google LLC", "/marks/connectors/google-analytics/icon.svg"],
      ["cloudflare", "Cloudflare, Inc.", "/marks/connectors/cloudflare/icon.png"],
      ["vizzybl", "Vizzybl", "/marks/connectors/vizzybl/icon.png"],
    ]);
    expect(parseManifest(cloudflareManifest).initials).toBe("CF");
    // Only Google Analytics asks for its wide logo beside its data, linked to it, at least 154 by 50.
    const lockups = MANIFESTS.map((m) => parseManifest(m).icon?.lockup).filter(Boolean);
    expect(lockups).toHaveLength(1);
    // Straight into Google Analytics, the same place as its home, so the source line lets people check the numbers there.
    expect(lockups[0]).toMatchObject({ href: "https://analytics.google.com/", alt: "Google Analytics" });
    expect(lockups[0]!.href).toBe(ga4Manifest.home);
    expect(lockups[0]!.width).toBeGreaterThanOrEqual(154);
    expect(lockups[0]!.height).toBeGreaterThanOrEqual(50);
  });

  it("refuses unknown keys anywhere, so a typo never passes quietly", () => {
    expect(issues({ ...base(), colour: "orange" }).length).toBeGreaterThan(0);
    expect(issues({ ...base(), api: { ...base().api, followRedirects: true } }).length).toBeGreaterThan(0);
  });

  it("has a sign in ask for one scope that a shares line names, with a picker named for the connector", () => {
    const sc = clone(searchConsoleManifest) as ConnectorManifestInput;
    const parsed = parseManifest(sc);
    expect(oauthMethod(parsed)?.scopes).toEqual(["https://www.googleapis.com/auth/webmasters.readonly"]);
    expect(tokenMethod(parsed)).toBeNull();
    expect(oauthMethod(parseManifest(cloudflareManifest))).toBeNull();
    const two = { method: "oauth_pkce", client: "google", scopes: ["https://www.googleapis.com/auth/webmasters.readonly", "https://www.googleapis.com/auth/analytics.readonly"] };
    expect(issues({ ...sc, connect: [two] }).length).toBeGreaterThan(0);
    expect(issues({ ...sc, shares: sc.shares.map((s) => ({ ...s, needs: [] })) }).join()).toContain("has no shares line");
    expect(issues({ ...sc, hooks: { live: sc.hooks.live } }).join()).toContain("needs hooks.accounts");
    expect(issues({ ...sc, hooks: { ...sc.hooks, accounts: "cloudflare.zones" } }).join()).toContain("connector's own name");
  });

  it("has share access name its role, its one scope with a shares line, and where to add the address", () => {
    const sc = clone(searchConsoleManifest) as ConnectorManifestInput;
    const parsed = parseManifest(sc);
    expect(shareMethod(parsed)).toMatchObject({ role: "Restricted", scopes: ["https://www.googleapis.com/auth/webmasters.readonly"] });
    expect(shareMethod(parseManifest(cloudflareManifest))).toBeNull();
    const share = sc.connect.find((c) => c.method === "share_access")!;
    const other = { ...share, scopes: ["https://www.googleapis.com/auth/analytics.readonly"] };
    expect(issues({ ...sc, connect: [sc.connect[0]!, other] }).join()).toContain("has no shares line");
    expect(issues({ ...sc, connect: [sc.connect[0]!, { ...share, steps: [] }] }).length).toBeGreaterThan(0);
    expect(issues({ ...sc, connect: [sc.connect[0]!, { ...share, scopes: [] }] }).length).toBeGreaterThan(0);
    expect(issues({ ...sc, connect: [share], hooks: { live: sc.hooks.live } }).join()).toContain("needs hooks.accounts");
  });

  it("finds a manifest's token method and streams", () => {
    const m = parseManifest(cloudflareManifest);
    expect(tokenMethod(m)?.auth.field).toBe("token");
    expect(streamOf(m, "zone_daily")?.measures).toEqual(["cfRequests", "cfPageViews", "cfVisits", "cfUniqueVisitors"]);
    expect(streamOf(m, "nope")).toBeNull();
    expect(() => parseManifest({ ...base(), id: "browse" })).toThrow(/bad_connector_manifest:browse:id: a reserved id/);
  });
});

describe("sharing one connection across an organisation's brands (Connectors 3)", () => {
  it("gives each built connector its own organisation budget, and says where a quota answer holds", () => {
    expect(parseManifest(searchConsoleManifest).api.limits.source).toEqual({ perMinute: 100, perHour: 1500, holds: "connection" });
    expect(parseManifest(ga4Manifest).api.limits.source).toEqual({ perMinute: 40, perHour: 480, holds: "part" });
    expect(parseManifest(cloudflareManifest).api.limits.source).toEqual({ perMinute: 40, perHour: 600, holds: "connection", holdMinutes: 5 });
    // Each stays under the provider's own limits: Search Console 1,200 a minute per user, Cloudflare 300 GraphQL queries per 5 minutes.
    expect(parseManifest(searchConsoleManifest).api.limits.source!.perMinute).toBeLessThan(1200);
    expect(parseManifest(cloudflareManifest).api.limits.source!.perMinute * 5).toBeLessThan(300);
  });

  it("never shares a connector with a personal stream", () => {
    const m = base();
    (m.produces[0] as { personal: boolean }).personal = true;
    (m.produces[0] as { collect?: unknown }).collect = undefined;
    (m.hooks as { collect?: string }).collect = undefined;
    expect(issues(m)).toContain(": a connector with a personal stream is never shared (limits.source)");
    m.api.limits.source = undefined;
    expect(issues(m)).not.toContain(": a connector with a personal stream is never shared (limits.source)");
  });
});


describe("connectors that read an MCP server (ADR-0019)", () => {
  const mcp = (): ConnectorManifestInput => clone(testMcpManifest) as unknown as ConnectorManifestInput;
  const method = (m: ConnectorManifestInput) => m.connect[0] as Extract<ConnectorManifestInput["connect"][number], { method: "mcp" }>;

  it("parses a data only connector: the engine's hooks, every stream with its tool and rows", () => {
    const m = parseManifest(mcp());
    expect(mcpMethod(m)?.url).toBe("https://mcp.example.test/v1/mcp");
    expect(m.hooks).toEqual({ live: MCP_HOOKS.live, collect: MCP_HOOKS.collect });
    expect(pastedFieldsOf(m)).toEqual({ fields: [method(mcp()).auth.field], bearer: "apiKey", account: null });
    expect(pastedFieldsOf(parseManifest(cloudflareManifest))).toMatchObject({ bearer: "token", account: "zoneId" });
    expect(clone(mcp())).toEqual(mcp());
  });

  it("names only the engine's hooks, and verifies with POST to its own server", () => {
    expect(issues({ ...mcp(), hooks: { live: "acmeAnswers.live", collect: MCP_HOOKS.collect } }).join()).toContain("reads live with mcp.live");
    expect(issues({ ...mcp(), hooks: { live: MCP_HOOKS.live, collect: "acmeAnswers.collect" } }).join()).toContain("collects with mcp.collect");
    expect(issues({ ...mcp(), hooks: { ...mcp().hooks, accounts: "mcp.accounts" } }).join()).toContain("not hooks.accounts");
    expect(issues({ ...mcp(), verify: { ...mcp().verify, hook: "acmeAnswers.check" } }).join()).toContain("verifies with POST");
    // The engine's hooks are only for a connector that connects by mcp.
    expect(issues({ ...base(), hooks: { ...base().hooks, live: MCP_HOOKS.live } }).join()).toContain("connector's own name");
  });

  it("refuses a server off its hosts, a key that isn't secret, and a permission with no shares line", () => {
    const m = mcp();
    expect(issues({ ...m, connect: [{ ...method(m), url: "https://mcp.elsewhere.test/v1/mcp" }] }).join()).toContain("not on a declared host");
    expect(issues({ ...m, connect: [{ ...method(m), auth: { kind: "bearer", field: { ...method(m).auth.field, secret: false } } }] }).join()).toContain("secret field");
    expect(issues({ ...m, connect: [{ ...method(m), permissions: ["Write everything"] }] }).join()).toContain("has no shares line");
    expect(issues({ ...m, connect: [{ ...method(m), auth: { kind: "oauth" } }] }).length).toBeGreaterThan(0);
    expect(issues({ ...m, connect: [method(m), clone(cloudflareManifest).connect[0]!] }).join()).toContain("connects by mcp alone");
    expect(issues({ ...m, api: { ...m.api, limits: { ...m.api.limits, source: { perMinute: 10, perHour: 100, holds: "connection" } } } }).join()).toContain("never shared");
  });

  it("maps every key and every number of a stream, and only those", () => {
    const m = mcp();
    const daily = m.produces[0]!;
    const block = daily.mcp!;
    expect(issues({ ...m, produces: [{ ...daily, mcp: undefined }, ...m.produces.slice(1)] }).join()).toContain("needs an mcp block");
    expect(issues({ ...m, produces: [{ ...daily, mcp: { ...block, keys: {} } }, ...m.produces.slice(1)] }).join()).toContain("mcp.keys");
    expect(issues({ ...m, produces: [{ ...daily, mcp: { ...block, measures: { cfRequests: "count", cfVisits: "visits" } } }, ...m.produces.slice(1)] }).join()).toContain("mcp.measures");
    expect(issues({ ...m, produces: [{ ...daily, mcp: { ...block, rows: "data[0]" } }, ...m.produces.slice(1)] }).length).toBeGreaterThan(0);
    expect(issues({ ...m, produces: [{ ...daily, mcp: { ...block, tool: "has space" } }, ...m.produces.slice(1)] }).length).toBeGreaterThan(0);
    expect(issues({ ...m, produces: [{ ...daily, mcp: { ...block, args: { startDate: "2026-01-01" } } }, ...m.produces.slice(1)] }).join()).toContain("both fixed and filled");
    expect(issues({ ...m, produces: [{ ...daily, mcp: { ...block, fill: { startDate: "from", since: "from" } } }, ...m.produces.slice(1)] }).join()).toContain("a fill is used twice");
    expect(issues({ ...m, produces: [{ ...daily, mcp: { ...block, fill: { startDate: "yesterday" } } }, ...m.produces.slice(1)] }).length).toBeGreaterThan(0);
    // A connector that doesn't connect by mcp has no mcp blocks.
    const cf = base();
    expect(issues({ ...cf, produces: [{ ...cf.produces[0]!, mcp: block }] }).join()).toContain("doesn't connect by mcp");
  });

  it("collects an MCP stream by day only, one row of totals a day", () => {
    const m = mcp();
    const daily = m.produces[0]!;
    const byPage = { ...daily, keys: ["day", "page"], joins: { day: "day" as const, page: "page" as const }, liveBy: ["day" as const, "page" as const], collect: { ...daily.collect!, by: ["day" as const, "page" as const] }, mcp: { ...daily.mcp!, keys: { day: "date", page: "url" } } };
    expect(issues({ ...m, produces: [byPage, ...m.produces.slice(1)] }).join()).toContain("collected by day only");
  });
});
