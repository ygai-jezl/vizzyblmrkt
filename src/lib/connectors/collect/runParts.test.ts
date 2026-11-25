import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forTenant, getOrganisationConnection, type SourceRef, type TenantContext } from "@/lib/tenant";
import type { DataConnection } from "@/lib/types/dataConnection";
import { answer, cfDays, cfSettings, routedTransport, type SeenCall } from "../testing/providers";
import { brandDeps, EU_BRAND, OCN, ORG, orgWorld, seedFernhill, seedPart, seedSource, T0, US_BRAND, USE_EU, USE_US, type OrgWorld } from "../testing/organisation";
import { sealConnectorSecret } from "../vault";
import { collectConnection } from "./run";

// Collecting a brand's part (Connectors 3): Fernhill Group's Cloudflare token, kept in Europe,
// serves a zone for Fernhill Plants (Europe) and one for Fernhill US (United States). Every number
// and zone is made up; nothing calls a provider.
const ZONE_US = "0123456789abcdef0123456789abcd01";
const ZONE_EU = "0123456789abcdef0123456789abcd02";
const NOW = new Date("2026-11-23T12:00:00.000Z");
const ALL_DAYS = Array.from({ length: 90 }, (_, i) => new Date(Date.parse("2026-08-24") + i * 86_400_000).toISOString().slice(0, 10));

let w: OrgWorld;
let source: SourceRef;
const US: TenantContext = { ...US_BRAND, source: "system" };
const EU: TenantContext = { ...EU_BRAND, source: "system" };
const good = () => routedTransport((c: SeenCall) => (String(c.body.query).includes("settings") ? answer(cfSettings()) : answer(cfDays(ALL_DAYS, ALL_DAYS.slice(-30)))));
const run = (ctx: TenantContext, id: string, transport: ReturnType<typeof routedTransport>["transport"], limit: (subject: string, config: { prefix: string }) => Promise<boolean> = async () => false) =>
  collectConnection(ctx, id, { deadlineMs: NOW.getTime() + 25_000 }, { ...brandDeps(w, ctx), transport, limit, log: () => {}, now: NOW, newLeaseId: () => "lease-1" });
const load = async (ctx: TenantContext, id: string) => (await forTenant(ctx, w.regionDb(ctx.region)).dataConnections.getById(id)) as DataConnection;
const orgRecord = async () => (await getOrganisationConnection(ORG, OCN, "eu", { regionDb: w.regionDb }))!;

beforeEach(async () => {
  for (const name of ["CONNECTORS_ENABLED", "CONNECTORS_COLLECT_ENABLED", "CONNECTOR_CLOUDFLARE_ENABLED", "PLANS_ENABLED", "CONNECTORS_SHARING_ENABLED"]) vi.stubEnv(name, "true");
  vi.stubEnv("CONNECTORS_VAULT_KEY", "collect-parts-vault-root-0123456789abcdef");
  w = orgWorld();
  seedFernhill(w);
  source = await seedSource(w, { secrets: { token: sealConnectorSecret(ORG, OCN, "token", "made-up-org-token", new Date(T0)) } });
  await seedPart(w, source, US_BRAND, { useId: USE_US, account: ZONE_US });
  await seedPart(w, source, EU_BRAND, { useId: USE_EU, account: ZONE_EU });
});
afterEach(() => vi.unstubAllEnvs());

describe("collecting a part", () => {
  it("fills 90 days in the brand's own region with the organisation's token, and nothing of the brand's reaches Europe", async () => {
    const { transport, calls } = good();
    expect(await run(US, USE_US, transport)).toEqual({ status: "collected", days: 90 });
    expect(calls.length).toBeGreaterThan(0);
    expect(w.us.dump("metric_snapshots").filter((d) => d.day)).toHaveLength(90);
    expect(w.us.dump("metric_snapshots").every((d) => d.connectionId === USE_US)).toBe(true);
    // Europe holds the sign in and the part entry only: no snapshot, no brand record of Fernhill US.
    expect(w.eu.dump("metric_snapshots").filter((d) => d.connectionId === USE_US)).toEqual([]);
    expect(w.eu.raw("data_connections", USE_US)).toBeUndefined();
  });

  it("counts every part's calls in the organisation connection's own budget", async () => {
    const seen: string[] = [];
    await run(US, USE_US, good().transport, async (subject: string, config: { prefix: string }) => {
      seen.push(`${config.prefix} ${subject}`);
      return false;
    });
    expect(seen).toContain(`connector-src:cloudflare ${ORG}:${OCN}`);
    expect(seen).toContain(`connector-brand:cloudflare ${US_BRAND.tenantId}`);
  });

  it("holds every part on a Cloudflare 429, while live reads go on", async () => {
    const limited = routedTransport(() => answer({ errors: [{ message: "rate limited" }] }, 429));
    expect(await run(US, USE_US, limited.transport)).toMatchObject({ status: "held" });
    expect((await orgRecord()).collectHold).toEqual({ until: new Date(NOW.getTime() + 5 * 60_000).toISOString(), reason: "quota" });
    expect((await orgRecord()).recent[0]).toMatchObject({ kind: "held", code: "quota" });
    // Fernhill Plants waits without calling Cloudflare at all.
    const quiet = good();
    expect(await run(EU, USE_EU, quiet.transport)).toEqual({ status: "held", days: 0 });
    expect(quiet.calls).toEqual([]);
    expect((await load(EU, USE_EU)).collect).toMatchObject({ nextAt: new Date(NOW.getTime() + 5 * 60_000).toISOString(), failedSince: null });
    expect((await load(EU, USE_EU)).health.state).toBe("ok");
  });

  it("puts a token turned down outright on the organisation's record, and source_broken on the part", async () => {
    const refused = routedTransport(() => answer({ data: null, errors: [{ message: "Invalid API Token" }] }, 401));
    expect(await run(US, USE_US, refused.transport)).toMatchObject({ status: "failed", code: "source_broken" });
    expect((await orgRecord()).health).toMatchObject({ state: "broken", lastErrorCode: "token_refused" });
    expect((await load(US, USE_US)).health).toMatchObject({ state: "check", lastErrorCode: "source_broken" });
    // The other part now fails before Cloudflare: the sign in needs its owners.
    const after = good();
    expect(await run(EU, USE_EU, after.transport)).toMatchObject({ status: "failed", code: "source_broken" });
    expect(after.calls).toEqual([]);
  });

  it.each(["CONNECTORS_SHARING_ENABLED", "PLANS_ENABLED"])("skips a part quietly while %s is off: no failure, nothing ended", async (name) => {
    vi.stubEnv(name, "false");
    const t = good();
    expect(await run(US, USE_US, t.transport)).toMatchObject({ status: "failed", code: "sharing_off" });
    expect(t.calls).toEqual([]);
    const conn = await load(US, USE_US);
    expect(conn).toMatchObject({ status: "connected", health: { state: "ok", failures: 0 } });
    expect(conn.collect?.failedSince ?? null).toBeNull();
    expect((await orgRecord()).parts.map((p) => p.state)).toEqual(["active", "active"]);
  });

  it("keeps a GA4 quota hold on the brand's own part: GA4 counts per property", async () => {
    vi.stubEnv("CONNECTOR_GA4_ENABLED", "true");
    vi.stubEnv("CONNECTORS_IDENTITIES_PROJECT", "made-up-identities");
    const GA = "ocn_gggggggggggggggggggg";
    const g = await seedSource(w, {
      id: GA,
      connectorId: "google-analytics",
      method: "share_access",
      label: "Google Analytics 4",
      serviceAccount: { email: "ygc-aaaaaaaaaaaaaaaaaaaa@made-up-identities.iam.gserviceaccount.com", uniqueId: "1001", createdAt: "2026-11-01T00:00:00.000Z", deletedAt: null },
    });
    const USE = "dcn_gaaaaaaaaaaaaaaaaaaa";
    await seedPart(w, g, US_BRAND, { useId: USE, account: "properties/123456789", connectorId: "google-analytics", method: "share_access" });
    const t = routedTransport((c) =>
      c.url.startsWith("https://iamcredentials.googleapis.com") ? answer({ accessToken: "made-up-minted", expireTime: new Date(NOW.getTime() + 300_000).toISOString() }) : answer({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }, 429),
    );
    const r = await collectConnection(US, USE, { deadlineMs: NOW.getTime() + 25_000 }, { ...brandDeps(w, US), transport: t.transport, limit: async () => false, log: () => {}, now: NOW, appToken: async () => "made-up-app-token", sleep: async () => {} });
    expect(r).toMatchObject({ status: "held" });
    expect((await load(US, USE)).collect).toMatchObject({ holdReason: "quota" });
    expect((await getOrganisationConnection(ORG, GA, "eu", { regionDb: w.regionDb }))!.collectHold).toBeNull();
  });
});
