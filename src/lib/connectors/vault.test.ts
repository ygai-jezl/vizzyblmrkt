import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  currentVaultKeyId,
  isOnCurrentKey,
  isVaultConfigured,
  openConnectorSecret,
  previousVaultKeyId,
  resealConnectorSecret,
  sealConnectorSecret,
  VAULT_UNCONFIGURED,
  vaultAad,
  VaultOpenError,
} from "./vault";

const KEY_A = "vault-test-root-a-0123456789abcdef0123456789";
const KEY_B = "vault-test-root-b-fedcba9876543210fedcba9876";
const TOKEN = "cf-token-made-up-for-tests-0000000000";

beforeEach(() => {
  vi.stubEnv("CONNECTORS_VAULT_KEY", KEY_A);
  vi.stubEnv("CONNECTORS_VAULT_KEY_PREVIOUS", "");
});
afterEach(() => vi.unstubAllEnvs());

const openErr = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    return err instanceof VaultOpenError ? err.why : String(err);
  }
  return "opened";
};

describe("the connector vault", () => {
  it("round-trips a secret bound to its brand, connection and slot, with a key id beside it", () => {
    const sealed = sealConnectorSecret("ten_a", "dcn_1", "token", TOKEN, new Date("2026-11-21T10:00:00Z"));
    expect(sealed.encKeyId).toMatch(/^[0-9a-f]{16}$/);
    expect(sealed.encKeyId).toBe(currentVaultKeyId());
    expect(sealed.sealedAt).toBe("2026-11-21T10:00:00.000Z");
    expect(JSON.stringify(sealed)).not.toContain(TOKEN);
    expect(openConnectorSecret("ten_a", "dcn_1", "token", sealed)).toBe(TOKEN);
  });

  it("won't open under another brand, connection or slot", () => {
    const sealed = sealConnectorSecret("ten_a", "dcn_1", "token", TOKEN);
    expect(openErr(() => openConnectorSecret("ten_b", "dcn_1", "token", sealed))).toBe("unopenable");
    expect(openErr(() => openConnectorSecret("ten_a", "dcn_2", "token", sealed))).toBe("unopenable");
    expect(openErr(() => openConnectorSecret("ten_a", "dcn_1", "refresh", sealed))).toBe("unopenable");
  });

  it("refuses a binding part that could blur the AAD", () => {
    expect(() => vaultAad("ten_a:dcn_1", "x", "token")).toThrow("bad_vault_binding");
    expect(() => vaultAad("ten_a", "", "token")).toThrow("bad_vault_binding");
  });

  it("refuses to save when the root key is unset, and opens nothing", () => {
    const sealed = sealConnectorSecret("ten_a", "dcn_1", "token", TOKEN);
    vi.stubEnv("CONNECTORS_VAULT_KEY", "");
    expect(isVaultConfigured()).toBe(false);
    expect(currentVaultKeyId()).toBeNull();
    expect(() => sealConnectorSecret("ten_a", "dcn_1", "token", TOKEN)).toThrow(VAULT_UNCONFIGURED);
    expect(openErr(() => openConnectorSecret("ten_a", "dcn_1", "token", sealed))).toBe("unknown_key");
  });

  it("opens a blob under the previous key during a rotation, and seals new ones under the current key", () => {
    const old = sealConnectorSecret("ten_a", "dcn_1", "token", TOKEN);
    vi.stubEnv("CONNECTORS_VAULT_KEY", KEY_B);
    vi.stubEnv("CONNECTORS_VAULT_KEY_PREVIOUS", KEY_A);
    expect(previousVaultKeyId()).toBe(old.encKeyId);
    expect(isOnCurrentKey(old)).toBe(false);
    expect(openConnectorSecret("ten_a", "dcn_1", "token", old)).toBe(TOKEN);
    const fresh = sealConnectorSecret("ten_a", "dcn_1", "token", TOKEN);
    expect(fresh.encKeyId).toBe(currentVaultKeyId());
    expect(fresh.encKeyId).not.toBe(old.encKeyId);
    // Once the previous key is gone, an old blob has no key to open it.
    vi.stubEnv("CONNECTORS_VAULT_KEY_PREVIOUS", "");
    expect(openErr(() => openConnectorSecret("ten_a", "dcn_1", "token", old))).toBe("unknown_key");
  });

  it("reseals onto the current key after checking the new blob opens, and leaves a current blob alone", () => {
    const old = sealConnectorSecret("ten_a", "dcn_1", "token", TOKEN);
    expect(resealConnectorSecret("ten_a", "dcn_1", "token", old)).toEqual({ ok: true, sealed: old, changed: false });
    vi.stubEnv("CONNECTORS_VAULT_KEY", KEY_B);
    vi.stubEnv("CONNECTORS_VAULT_KEY_PREVIOUS", KEY_A);
    const r = resealConnectorSecret("ten_a", "dcn_1", "token", old);
    expect(r.ok && r.changed).toBe(true);
    if (!r.ok) throw new Error("reseal failed");
    expect(isOnCurrentKey(r.sealed)).toBe(true);
    expect(openConnectorSecret("ten_a", "dcn_1", "token", r.sealed)).toBe(TOKEN);
  });

  it("reports a blob that won't open instead of resealing it", () => {
    const old = sealConnectorSecret("ten_a", "dcn_1", "token", TOKEN);
    vi.stubEnv("CONNECTORS_VAULT_KEY", KEY_B);
    expect(resealConnectorSecret("ten_a", "dcn_1", "token", old)).toEqual({ ok: false, why: "unknown_key" });
    vi.stubEnv("CONNECTORS_VAULT_KEY_PREVIOUS", KEY_A);
    expect(resealConnectorSecret("ten_b", "dcn_1", "token", old)).toEqual({ ok: false, why: "unopenable" });
    vi.stubEnv("CONNECTORS_VAULT_KEY", "");
    expect(resealConnectorSecret("ten_a", "dcn_1", "token", old)).toEqual({ ok: false, why: "unconfigured" });
  });
});
