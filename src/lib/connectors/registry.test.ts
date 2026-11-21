import { afterEach, describe, expect, it, vi } from "vitest";
import { parseManifest } from "./manifest";
import { cloudflareManifest } from "./manifests/cloudflare";
import { allConnectors, BUILT_METHODS, CONNECTOR_SWITCHES, getConnector, knownConnector, listConnectors, readyMethods, refusals } from "./registry";

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

  it("builds every sign-in method, and refuses one a piece hasn't built", () => {
    expect([...BUILT_METHODS]).toEqual(["token_fields", "oauth_pkce", "share_access"]);
    const sc = knownConnector("search-console")!;
    expect(refusals(sc, ["token_fields", "oauth_pkce"])).toEqual(["search-console: the share_access sign-in is not built yet"]);
    vi.stubEnv("CONNECTORS_IDENTITIES_PROJECT", "made-up-identities");
    expect(readyMethods(sc, ["token_fields", "oauth_pkce"])).toEqual([]);
    expect(readyMethods(sc)).toEqual(["share_access"]);
  });

  it("offers Search Console only with its switch, the core and a Google client", () => {
    vi.stubEnv("CONNECTORS_ENABLED", "true");
    vi.stubEnv("CONNECTOR_SEARCH_CONSOLE_ENABLED", "true");
    expect(getConnector("search-console")).toBeNull();
    expect(readyMethods(knownConnector("search-console")!)).toEqual([]);
    vi.stubEnv("CONNECTOR_GOOGLE_CLIENT_ID", "made-up-client.example.test");
    vi.stubEnv("CONNECTOR_GOOGLE_CLIENT_SECRET", "made-up-client-secret");
    expect(getConnector("search-console")?.name).toBe("Google Search Console");
    expect(readyMethods(knownConnector("search-console")!)).toEqual(["oauth_pkce"]);
    vi.stubEnv("CONNECTOR_SEARCH_CONSOLE_ENABLED", "false");
    expect(getConnector("search-console")).toBeNull();
  });

  it("offers Google Analytics only with its switch, the core and one way to connect", () => {
    vi.stubEnv("CONNECTORS_ENABLED", "true");
    vi.stubEnv("CONNECTOR_GA4_ENABLED", "true");
    expect(getConnector("google-analytics")).toBeNull();
    vi.stubEnv("CONNECTORS_IDENTITIES_PROJECT", "made-up-identities");
    expect(readyMethods(knownConnector("google-analytics")!)).toEqual(["share_access"]);
    vi.stubEnv("CONNECTOR_GOOGLE_CLIENT_ID", "made-up-client.example.test");
    vi.stubEnv("CONNECTOR_GOOGLE_CLIENT_SECRET", "made-up-client-secret");
    expect(readyMethods(knownConnector("google-analytics")!)).toEqual(["oauth_pkce", "share_access"]);
    expect(getConnector("google-analytics")?.name).toBe("Google Analytics");
    vi.stubEnv("CONNECTOR_GA4_ENABLED", "1");
    expect(getConnector("google-analytics")).toBeNull();
  });

  it("refuses a personal stream while the data processing agreement is closed, and an unknown switch", () => {
    const m = cf();
    expect(refusals({ ...m, produces: [{ ...m.produces[0]!, personal: true }] })).toEqual([
      "cloudflare: zone_daily is personal, which waits for the data processing agreement",
    ]);
    expect(refusals({ ...m, switch: "CONNECTOR_NOBODY_ENABLED" })).toEqual(["cloudflare: no switch reads CONNECTOR_NOBODY_ENABLED"]);
  });
});
