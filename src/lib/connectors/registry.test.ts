import { afterEach, describe, expect, it, vi } from "vitest";
import { parseManifest } from "./manifest";
import { cloudflareManifest } from "./manifests/cloudflare";
import { allConnectors, CONNECTOR_SWITCHES, getConnector, knownConnector, listConnectors, refusals } from "./registry";

afterEach(() => vi.unstubAllEnvs());

const cf = () => parseManifest(cloudflareManifest);

describe("the connector registry", () => {
  it("offers nothing with every switch off", () => {
    expect(listConnectors()).toEqual([]);
    expect(getConnector("cloudflare")).toBeNull();
    expect(knownConnector("cloudflare")?.name).toBe("Cloudflare");
  });

  it("offers a connector only when the core and its own switch are both exactly true", () => {
    vi.stubEnv("CONNECTOR_CLOUDFLARE_ENABLED", "true");
    expect(getConnector("cloudflare")).toBeNull();
    vi.stubEnv("CONNECTORS_ENABLED", "TRUE");
    expect(getConnector("cloudflare")).toBeNull();
    vi.stubEnv("CONNECTORS_ENABLED", "true");
    expect(getConnector("cloudflare")?.id).toBe("cloudflare");
    expect(listConnectors().map((m) => m.id)).toEqual(["cloudflare"]);
    expect(getConnector("browse")).toBeNull();
  });

  it("has a switch reader for every manifest, and each reads the manifest's own variable", () => {
    for (const m of allConnectors()) {
      const read = CONNECTOR_SWITCHES[m.switch];
      expect(read, m.switch).toBeDefined();
      vi.stubEnv("CONNECTORS_ENABLED", "true");
      vi.stubEnv(m.switch, "false");
      expect(read!()).toBe(false);
      vi.stubEnv(m.switch, "true");
      expect(read!()).toBe(true);
    }
  });

  it("refuses no manifest in the repo", () => {
    for (const m of allConnectors()) expect(refusals(m), m.id).toEqual([]);
  });

  it("refuses a sign-in method that isn't built yet", () => {
    const withOAuth = parseManifest({
      ...cloudflareManifest,
      connect: [...cloudflareManifest.connect, { method: "oauth_pkce", client: "google", scopes: ["https://www.googleapis.com/auth/webmasters.readonly"] }],
      shares: cloudflareManifest.shares.map((s, i) => (i === 0 ? { ...s, needs: [...s.needs!, "https://www.googleapis.com/auth/webmasters.readonly"] } : s)),
    });
    expect(refusals(withOAuth)).toEqual(["cloudflare: the oauth_pkce sign-in is not built yet"]);
    const withShare = parseManifest({ ...cloudflareManifest, connect: [...cloudflareManifest.connect, { method: "share_access", google: "ga4", role: "Viewer" }] });
    expect(refusals(withShare)).toEqual(["cloudflare: the share_access sign-in is not built yet"]);
  });

  it("refuses a personal stream while the data processing agreement is closed, and an unknown switch", () => {
    const m = cf();
    expect(refusals({ ...m, produces: [{ ...m.produces[0]!, personal: true }] })).toEqual([
      "cloudflare: zone_daily is personal, which waits for the data processing agreement",
    ]);
    expect(refusals({ ...m, switch: "CONNECTOR_NOBODY_ENABLED" })).toEqual(["cloudflare: no switch reads CONNECTOR_NOBODY_ENABLED"]);
  });
});
