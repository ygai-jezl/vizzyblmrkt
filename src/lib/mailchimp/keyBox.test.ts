import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  MAILCHIMP_KEY_UNCONFIGURED,
  hasOwnMailchimpKey,
  isMailchimpKeySealingEnabled,
  readOwnMailchimpKey,
  sealMailchimpKey,
  storedKeyFields,
} from "./keyBox";

const ROOT = "MAILCHIMP_KEY_ENC_KEY";
const SWITCH = "MAILCHIMP_KEY_SEALED_ENABLED";
// Not Mailchimp's real key shape, so secret scanners don't flag the test.
const KEY = "test-only-not-a-real-key-us21";

describe("Mailchimp key box", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of [ROOT, SWITCH]) saved[k] = process.env[k];
    process.env[ROOT] = "test-only-root-not-a-real-secret-0123456789";
    delete process.env[SWITCH];
  });
  afterEach(() => {
    for (const k of [ROOT, SWITCH]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("is off unless the switch says exactly true", () => {
    expect(isMailchimpKeySealingEnabled()).toBe(false);
    process.env[SWITCH] = "1";
    expect(isMailchimpKeySealingEnabled()).toBe(false);
    process.env[SWITCH] = "true";
    expect(isMailchimpKeySealingEnabled()).toBe(true);
  });

  it("seals a key that only its own brand can open", () => {
    const apiKeyEnc = sealMailchimpKey("ten_a", KEY);
    expect(JSON.stringify(apiKeyEnc)).not.toContain(KEY);
    const cfg = { requiresOwnApiKey: false, apiKeyEnc };
    expect(readOwnMailchimpKey("ten_a", cfg)).toEqual({ ok: true, apiKey: KEY });
    expect(readOwnMailchimpKey("ten_b", cfg)).toEqual({ ok: false });
  });

  it("can't open a sealed key without the root secret, or with a different one", () => {
    const cfg = { requiresOwnApiKey: false, apiKeyEnc: sealMailchimpKey("ten_a", KEY) };
    process.env[ROOT] = "a-different-test-root-not-a-real-secret-9876";
    expect(readOwnMailchimpKey("ten_a", cfg)).toEqual({ ok: false });
    delete process.env[ROOT];
    expect(readOwnMailchimpKey("ten_a", cfg)).toEqual({ ok: false });
  });

  it("still reads a plain key saved before sealing, and none at all", () => {
    expect(readOwnMailchimpKey("ten_a", { requiresOwnApiKey: false, apiKey: ` ${KEY} ` })).toEqual({
      ok: true,
      apiKey: KEY,
    });
    expect(readOwnMailchimpKey("ten_a", undefined)).toEqual({ ok: true, apiKey: null });
    expect(readOwnMailchimpKey("ten_a", { requiresOwnApiKey: false, apiKey: "  " })).toEqual({
      ok: true,
      apiKey: null,
    });
  });

  it("prefers the sealed key when both forms are present", () => {
    const cfg = {
      requiresOwnApiKey: false,
      apiKey: "stale-us1",
      apiKeyEnc: sealMailchimpKey("ten_a", KEY),
    };
    expect(readOwnMailchimpKey("ten_a", cfg)).toEqual({ ok: true, apiKey: KEY });
  });

  it("says a key is set for either form", () => {
    expect(hasOwnMailchimpKey(undefined)).toBe(false);
    expect(hasOwnMailchimpKey({ requiresOwnApiKey: false, apiKey: " " })).toBe(false);
    expect(hasOwnMailchimpKey({ requiresOwnApiKey: false, apiKey: KEY })).toBe(true);
    expect(
      hasOwnMailchimpKey({ requiresOwnApiKey: false, apiKeyEnc: sealMailchimpKey("ten_a", KEY) }),
    ).toBe(true);
  });

  describe("storedKeyFields (what a settings save stores)", () => {
    const plain = { requiresOwnApiKey: true, apiKey: KEY };

    it("with sealing on, seals a new key and stores no plain text", () => {
      const out = storedKeyFields("ten_a", plain, ` ${KEY} `, true);
      expect(out.apiKey).toBeUndefined();
      expect(readOwnMailchimpKey("ten_a", { requiresOwnApiKey: true, ...out })).toEqual({
        ok: true,
        apiKey: KEY,
      });
    });

    it("with sealing on, seals a plain key that is kept", () => {
      const out = storedKeyFields("ten_a", plain, undefined, true);
      expect(out.apiKey).toBeUndefined();
      expect(out.apiKeyEnc).toBeDefined();
      expect(readOwnMailchimpKey("ten_a", { requiresOwnApiKey: true, ...out })).toEqual({
        ok: true,
        apiKey: KEY,
      });
    });

    it("carries a sealed key over as is, with the switch on or off", () => {
      const apiKeyEnc = sealMailchimpKey("ten_a", KEY);
      const existing = { requiresOwnApiKey: true, apiKeyEnc };
      expect(storedKeyFields("ten_a", existing, undefined, true)).toEqual({ apiKeyEnc });
      expect(storedKeyFields("ten_a", existing, undefined, false)).toEqual({ apiKeyEnc });
    });

    it("clears the key in both forms when it's blank", () => {
      const existing = { ...plain, apiKeyEnc: sealMailchimpKey("ten_a", KEY) };
      expect(storedKeyFields("ten_a", existing, "", true)).toEqual({});
      expect(storedKeyFields("ten_a", existing, "  ", false)).toEqual({});
    });

    it("with sealing off, stores plain text as before", () => {
      expect(storedKeyFields("ten_a", undefined, KEY, false)).toEqual({ apiKey: KEY });
      expect(storedKeyFields("ten_a", plain, undefined, false)).toEqual({ apiKey: KEY });
      expect(storedKeyFields("ten_a", undefined, undefined, false)).toEqual({});
    });

    it("refuses rather than store plain text when sealing is on but the root is missing", () => {
      delete process.env[ROOT];
      expect(() => storedKeyFields("ten_a", undefined, KEY, true)).toThrow(
        MAILCHIMP_KEY_UNCONFIGURED,
      );
      expect(() => storedKeyFields("ten_a", plain, undefined, true)).toThrow(
        MAILCHIMP_KEY_UNCONFIGURED,
      );
      // Nothing to seal: no root needed.
      expect(storedKeyFields("ten_a", undefined, undefined, true)).toEqual({});
    });
  });
});
