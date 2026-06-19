import { describe, it, expect, afterEach, vi } from "vitest";

/**
 * The Live-token gate must accept the 2026 Google AI Studio "authorization key"
 * format (which is NOT the legacy "AIza*" prefix), while still treating the
 * "disabled" sentinel / unset / empty as OFF. getLiveTokenClient memoizes at
 * module scope, so each case re-imports a fresh module after setting the env.
 */
const ORIGINAL = process.env.GEMINI_LIVE_API_KEY;

async function freshModule(value: string | undefined) {
  vi.resetModules();
  if (value === undefined) delete process.env.GEMINI_LIVE_API_KEY;
  else process.env.GEMINI_LIVE_API_KEY = value;
  return import("./gemini");
}

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.GEMINI_LIVE_API_KEY;
  else process.env.GEMINI_LIVE_API_KEY = ORIGINAL;
});

describe("getLiveTokenClient gate", () => {
  it("is OFF when unset", async () => {
    const m = await freshModule(undefined);
    expect(m.isLiveConfigured()).toBe(false);
    expect(m.getLiveTokenClient()).toBeNull();
  });

  it("is OFF for the 'disabled' sentinel (case-insensitive)", async () => {
    expect((await freshModule("disabled")).isLiveConfigured()).toBe(false);
    expect((await freshModule("DISABLED")).isLiveConfigured()).toBe(false);
  });

  it("is OFF for empty / whitespace-only values", async () => {
    expect((await freshModule("")).isLiveConfigured()).toBe(false);
    expect((await freshModule("   ")).isLiveConfigured()).toBe(false);
  });

  it("is ON for a 2026 auth key (AQ.* prefix), not just legacy AIza*", async () => {
    const m = await freshModule("AQ.Ab8RN6Jf_fake_auth_key_for_test_only");
    expect(m.isLiveConfigured()).toBe(true);
    expect(m.getLiveTokenClient()).not.toBeNull();
  });

  it("is ON for a legacy AIza* key", async () => {
    expect((await freshModule("AIzaSyFakeLegacyKeyForTestOnly")).isLiveConfigured()).toBe(true);
  });
});
