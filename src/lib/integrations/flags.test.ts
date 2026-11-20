import { afterEach, describe, expect, it, vi } from "vitest";
import { isConnectorRevokeEnabled, isConnectorRevokeXEnabled } from "./flags";

// Both switches ship off. X revoke has its own switch and only acts when the main
// revoke switch is on too. Anything but the exact string "true" is off.
afterEach(() => vi.unstubAllEnvs());

describe("revoke switches", () => {
  it("are off when unset", () => {
    vi.stubEnv("CONNECTOR_REVOKE_ENABLED", "");
    vi.stubEnv("CONNECTOR_REVOKE_X_ENABLED", "");
    expect(isConnectorRevokeEnabled()).toBe(false);
    expect(isConnectorRevokeXEnabled()).toBe(false);
  });

  it("are off for anything but the exact string true", () => {
    for (const v of ["1", "TRUE", "yes", " true"]) {
      vi.stubEnv("CONNECTOR_REVOKE_ENABLED", v);
      vi.stubEnv("CONNECTOR_REVOKE_X_ENABLED", v);
      expect(isConnectorRevokeEnabled(), v).toBe(false);
      expect(isConnectorRevokeXEnabled(), v).toBe(false);
    }
  });

  it("the revoke switch alone leaves X off", () => {
    vi.stubEnv("CONNECTOR_REVOKE_ENABLED", "true");
    vi.stubEnv("CONNECTOR_REVOKE_X_ENABLED", "");
    expect(isConnectorRevokeEnabled()).toBe(true);
    expect(isConnectorRevokeXEnabled()).toBe(false);
  });

  it("the X switch alone does nothing", () => {
    vi.stubEnv("CONNECTOR_REVOKE_ENABLED", "false");
    vi.stubEnv("CONNECTOR_REVOKE_X_ENABLED", "true");
    expect(isConnectorRevokeEnabled()).toBe(false);
    expect(isConnectorRevokeXEnabled()).toBe(false);
  });

  it("both on turns X on", () => {
    vi.stubEnv("CONNECTOR_REVOKE_ENABLED", "true");
    vi.stubEnv("CONNECTOR_REVOKE_X_ENABLED", "true");
    expect(isConnectorRevokeXEnabled()).toBe(true);
  });
});
