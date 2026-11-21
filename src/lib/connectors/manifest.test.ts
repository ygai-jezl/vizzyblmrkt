import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { MEANINGS } from "@/lib/metrics/meanings";
import { ConnectorManifestSchema, parseManifest, RESERVED_CONNECTOR_IDS, streamOf, tokenMethod, type ConnectorManifestInput } from "./manifest";
import { cloudflareManifest } from "./manifests/cloudflare";
import { MANIFESTS } from "./registry";

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

  it("refuses unknown keys anywhere, so a typo never passes quietly", () => {
    expect(issues({ ...base(), colour: "orange" }).length).toBeGreaterThan(0);
    expect(issues({ ...base(), api: { ...base().api, followRedirects: true } }).length).toBeGreaterThan(0);
  });

  it("finds a manifest's token method and streams", () => {
    const m = parseManifest(cloudflareManifest);
    expect(tokenMethod(m)?.auth.field).toBe("token");
    expect(streamOf(m, "zone_daily")?.measures).toEqual(["cfRequests", "cfPageViews", "cfVisits"]);
    expect(streamOf(m, "nope")).toBeNull();
    expect(() => parseManifest({ ...base(), id: "browse" })).toThrow(/bad_connector_manifest:browse:id: a reserved id/);
  });
});
