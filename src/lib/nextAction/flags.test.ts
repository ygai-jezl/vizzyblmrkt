import { afterEach, describe, expect, it, vi } from "vitest";
import { isNextActionCardEnabled } from "./flags";

afterEach(() => vi.unstubAllEnvs());

describe("NEXT_ACTION_CARD_ENABLED", () => {
  it("is on only when it and ONBOARDING_ENABLED are exactly true", () => {
    vi.stubEnv("ONBOARDING_ENABLED", "true");
    vi.stubEnv("NEXT_ACTION_CARD_ENABLED", "true");
    expect(isNextActionCardEnabled()).toBe(true);
    for (const value of ["", "false", "TRUE", "1", "yes"]) {
      vi.stubEnv("NEXT_ACTION_CARD_ENABLED", value);
      expect(isNextActionCardEnabled(), value).toBe(false);
    }
    vi.stubEnv("NEXT_ACTION_CARD_ENABLED", "true");
    vi.stubEnv("ONBOARDING_ENABLED", "");
    expect(isNextActionCardEnabled()).toBe(false);
  });
});
