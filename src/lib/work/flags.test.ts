import { afterEach, describe, expect, it, vi } from "vitest";
import { isWorkEnabled, isWorkQuickEditEnabled, isWorkVizzyEnabled } from "./flags";

// Work's switches, read as the exact string "true". Quick edit on the list needs Work itself.
afterEach(() => vi.unstubAllEnvs());

describe("Work quick edit's switch", () => {
  it("is on only with WORK_QUICK_EDIT_ENABLED and WORK_ENABLED both exactly true", () => {
    vi.stubEnv("WORK_ENABLED", "true");
    vi.stubEnv("WORK_QUICK_EDIT_ENABLED", "true");
    expect(isWorkQuickEditEnabled()).toBe(true);
  });

  it("is off when unset, or set to anything but true", () => {
    vi.stubEnv("WORK_ENABLED", "true");
    vi.stubEnv("WORK_QUICK_EDIT_ENABLED", "");
    expect(isWorkQuickEditEnabled()).toBe(false);
    for (const v of ["false", "TRUE", "1", "yes", " true"]) {
      vi.stubEnv("WORK_QUICK_EDIT_ENABLED", v);
      expect(isWorkQuickEditEnabled(), v).toBe(false);
    }
  });

  it("is off while Work itself is off, and leaves Work's other switches alone", () => {
    vi.stubEnv("WORK_ENABLED", "false");
    vi.stubEnv("WORK_QUICK_EDIT_ENABLED", "true");
    vi.stubEnv("WORK_VIZZY_ENABLED", "true");
    expect(isWorkQuickEditEnabled()).toBe(false);
    expect(isWorkEnabled()).toBe(false);
    expect(isWorkVizzyEnabled()).toBe(false);
    vi.stubEnv("WORK_ENABLED", "true");
    vi.stubEnv("WORK_QUICK_EDIT_ENABLED", "false");
    expect(isWorkVizzyEnabled()).toBe(true);
    expect(isWorkQuickEditEnabled()).toBe(false);
  });
});
