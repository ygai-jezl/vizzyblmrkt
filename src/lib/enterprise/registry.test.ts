import { afterEach, describe, expect, it, vi } from "vitest";
import { ENTERPRISE_FEATURE_IDS } from "./features";
import { verifyLicenceKey, type LicenceResult } from "./licence";
import { EE_CODE, enterpriseFeature, enterpriseStatus, isLicensed } from "./registry";
import { goodClaims, makeLicenceKeyPair } from "./testing/licence";

// Never reads or imports the Enterprise folder: CI runs these tests with it deleted.

const NOW = Date.parse("2026-11-20T12:00:00Z");
const NOW_SEC = Math.floor(NOW / 1000);
const pair = makeLicenceKeyPair();
const licenceOf = (overrides: Record<string, unknown> = {}) => (): LicenceResult =>
  verifyLicenceKey({ key: pair.mint(goodClaims(NOW, overrides)), keys: [pair.publicJwk], nowMs: NOW });
const allFeatures = licenceOf({ features: [...ENTERPRISE_FEATURE_IDS] });
const withCode = { hasCode: () => true };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the Enterprise registry", () => {
  it("ships with no Enterprise code, so every feature is off as code_absent, even with a valid licence", () => {
    expect(EE_CODE).toEqual({});
    for (const feature of ENTERPRISE_FEATURE_IDS) {
      expect(enterpriseFeature(feature, { licence: allFeatures })).toEqual({ feature, on: false, reason: "code_absent" });
      expect(enterpriseFeature(feature)).toEqual({ feature, on: false, reason: "code_absent" });
      expect(isLicensed(feature)).toBe(false);
    }
  });

  it("gives no_key with the code and no licence key set", () => {
    vi.stubEnv("ENTERPRISE_LICENCE_KEY", undefined);
    expect(enterpriseFeature("sso", withCode)).toEqual({ feature: "sso", on: false, reason: "no_key" });
  });

  it("turns a feature on when the licence lists it, with who it is for", () => {
    const answer = enterpriseFeature("sso", { ...withCode, licence: licenceOf() });
    const claims = goodClaims(NOW);
    expect(answer).toEqual({
      feature: "sso",
      on: true,
      reason: "licensed",
      licence: { licensee: claims.licensee, seats: claims.seats, exp: claims.exp },
    });
    expect(isLicensed("sso", { ...withCode, licence: licenceOf() })).toBe(true);
  });

  it("keeps a feature the licence doesn't list off", () => {
    const answer = enterpriseFeature("legal_hold", { ...withCode, licence: licenceOf() });
    expect(answer).toMatchObject({ feature: "legal_hold", on: false, reason: "not_in_licence" });
    expect(answer.licence?.licensee).toBe("Example Ltd");
  });

  it("keeps everything off on an expired licence, and says when it ended", () => {
    const exp = NOW_SEC - 60;
    const answer = enterpriseFeature("sso", { ...withCode, licence: licenceOf({ iat: NOW_SEC - 7200, exp }) });
    expect(answer).toMatchObject({ on: false, reason: "expired", licence: { exp } });
  });

  it("never throws on a garbage setting or a failing check", () => {
    for (const garbage of ["true", "ygel_", "ygel_a.b.c", "ygel_..", "x".repeat(5000)]) {
      vi.stubEnv("ENTERPRISE_LICENCE_KEY", garbage);
      expect(() => enterpriseFeature("sso", withCode)).not.toThrow();
      expect(enterpriseFeature("sso", withCode)).toEqual({ feature: "sso", on: false, reason: "malformed" });
      expect(() => enterpriseStatus(withCode)).not.toThrow();
    }
    const throws = () => {
      throw new Error("boom");
    };
    expect(enterpriseFeature("sso", { ...withCode, licence: throws })).toMatchObject({ on: false, reason: "malformed" });
    expect(enterpriseFeature("sso", { hasCode: throws, licence: allFeatures })).toMatchObject({ on: false, reason: "code_absent" });
  });

  it("lists every feature once, reading the licence once", () => {
    const licence = vi.fn(allFeatures);
    const status = enterpriseStatus({ ...withCode, licence });
    expect(status.map((a) => a.feature)).toEqual([...ENTERPRISE_FEATURE_IDS]);
    expect(status.every((a) => a.on && a.reason === "licensed")).toBe(true);
    expect(licence).toHaveBeenCalledTimes(1);
    expect(enterpriseStatus().map((a) => a.reason)).toEqual(ENTERPRISE_FEATURE_IDS.map(() => "code_absent"));
  });
});
