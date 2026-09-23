import { describe, it, expect, afterEach, vi } from "vitest";
import { gaConfig, gaBootstrapScript, isGaTrackedPath, CONSENT_REQUIRED_REGIONS } from "./googleAnalytics";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("gaConfig", () => {
  it("is off unless enabled with a valid measurement ID", () => {
    vi.stubEnv("NEXT_PUBLIC_GA_MEASUREMENT_ID", "G-TEST1234");
    expect(gaConfig()).toBeNull();

    vi.stubEnv("NEXT_PUBLIC_GA_ENABLED", "true");
    expect(gaConfig()).toEqual({ measurementId: "G-TEST1234", debugMode: false });

    vi.stubEnv("NEXT_PUBLIC_GA_DEBUG_MODE", "true");
    expect(gaConfig()).toEqual({ measurementId: "G-TEST1234", debugMode: true });
  });

  it("rejects anything that isn't a GA4 measurement ID", () => {
    vi.stubEnv("NEXT_PUBLIC_GA_ENABLED", "true");
    for (const bad of ["", "UA-12345-1", "g-test1234", "G-TEST');alert(1)//"]) {
      vi.stubEnv("NEXT_PUBLIC_GA_MEASUREMENT_ID", bad);
      expect(gaConfig()).toBeNull();
    }
  });
});

describe("isGaTrackedPath", () => {
  it("measures only the public site", () => {
    for (const p of ["/", "/login", "/developers", "/developers/events"]) {
      expect(isGaTrackedPath(p)).toBe(true);
    }
    for (const p of [
      null,
      "/admin",
      "/admin/signups",
      "/embed/c1",
      "/waitlist/c1",
      "/admin-preview/c1",
      "/unsubscribe",
      "/developersx",
    ]) {
      expect(isGaTrackedPath(p)).toBe(false);
    }
  });
});

describe("gaBootstrapScript", () => {
  it("sets consent defaults before config", () => {
    const js = gaBootstrapScript({ measurementId: "G-TEST1234", debugMode: false });
    const consent = js.indexOf("'consent', 'default'");
    const config = js.indexOf("'config'");
    expect(consent).toBeGreaterThan(-1);
    expect(config).toBeGreaterThan(consent);
    expect(js).toContain("gtag('config', 'G-TEST1234');");
    expect(js).not.toContain("debug_mode");
  });

  it("denies all storage in consent regions and ads storage everywhere", () => {
    const js = gaBootstrapScript({ measurementId: "G-TEST1234", debugMode: false });
    const defaults = [...js.matchAll(/gtag\('consent', 'default', (\{.*\})\);/g)].map((m) => JSON.parse(m[1] ?? ""));
    expect(defaults).toHaveLength(2);
    const [regional, global] = defaults;
    expect(regional.region).toEqual(CONSENT_REQUIRED_REGIONS);
    expect(regional.analytics_storage).toBe("denied");
    expect(regional.region).toEqual(expect.arrayContaining(["GB", "DE", "CH", "NO"]));
    expect(global.region).toBeUndefined();
    expect(global.analytics_storage).toBe("granted");
    for (const d of defaults) {
      expect(d.ad_storage).toBe("denied");
      expect(d.ad_user_data).toBe("denied");
      expect(d.ad_personalization).toBe("denied");
    }
  });

  it("adds debug_mode only in debug", () => {
    const js = gaBootstrapScript({ measurementId: "G-TEST1234", debugMode: true });
    expect(js).toContain("gtag('config', 'G-TEST1234', { debug_mode: true });");
  });

  it("refuses an ID that could break out of the inline script", () => {
    expect(() => gaBootstrapScript({ measurementId: "G-X');alert(1)//", debugMode: false })).toThrow();
  });
});
