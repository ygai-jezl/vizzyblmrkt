import { afterEach, describe, expect, it, vi } from "vitest";
import { isRaiseKitEnabled, isVizzyRaiseEnabled } from "./flags";

afterEach(() => vi.unstubAllEnvs());

describe("the Raise kit's switches", () => {
  it("are off unless exactly \"true\"", () => {
    for (const v of ["", "false", "TRUE", "1", "yes"]) {
      vi.stubEnv("RAISE_KIT_ENABLED", v);
      vi.stubEnv("VIZZY_RAISE_ENABLED", v);
      expect(isRaiseKitEnabled(), v).toBe(false);
      expect(isVizzyRaiseEnabled(), v).toBe(false);
    }
    vi.stubEnv("RAISE_KIT_ENABLED", "true");
    expect(isRaiseKitEnabled()).toBe(true);
  });

  it("turn Vizzy's decks on only with the kit", () => {
    vi.stubEnv("VIZZY_RAISE_ENABLED", "true");
    vi.stubEnv("RAISE_KIT_ENABLED", "false");
    expect(isVizzyRaiseEnabled()).toBe(false);
    vi.stubEnv("RAISE_KIT_ENABLED", "true");
    expect(isVizzyRaiseEnabled()).toBe(true);
  });
});
