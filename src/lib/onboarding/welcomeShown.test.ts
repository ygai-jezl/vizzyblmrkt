import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markWelcomeShown } from "./welcomeShown";

const ADMIN = { tenantId: "ten_new", region: "us" as const, userId: "uid_admin", role: "admin" as const, source: "idtoken" as const };
const MEMBER = { ...ADMIN, role: "member" as const };
const NEW_BRAND = { businessProfile: undefined };
const FRESH = { recordsEver: 0, signups: 0, setup: undefined };

function deps(signals: Record<string, unknown> = FRESH, started = true) {
  return {
    loadSignals: vi.fn().mockResolvedValue(signals) as never,
    start: vi.fn().mockResolvedValue(started),
  };
}

describe("markWelcomeShown", () => {
  beforeEach(() => {
    process.env.ONBOARDING_ENABLED = "true";
  });
  afterEach(() => {
    delete process.env.ONBOARDING_ENABLED;
  });

  it("marks the welcome shown for a new brand's admin", async () => {
    const d = deps();
    expect(await markWelcomeShown(ADMIN, NEW_BRAND, d)).toBe(true);
    expect(d.start).toHaveBeenCalledWith("ten_new");
  });

  it("leaves a busy brand alone when it opens the welcome from Settings, so its sidebar stays", async () => {
    const d = deps({ recordsEver: 3, signups: 12 });
    expect(await markWelcomeShown(ADMIN, NEW_BRAND, d)).toBe(false);
    expect(d.start).not.toHaveBeenCalled();
  });

  it("leaves a brand that has a profile alone, with no reads", async () => {
    const d = deps();
    const tenant = { businessProfile: { status: "skipped" as const, answers: {}, rev: 0, startedAt: "2026-11-25T09:00:00.000Z" } };
    expect(await markWelcomeShown(ADMIN, tenant, d)).toBe(false);
    expect(d.loadSignals).not.toHaveBeenCalled();
    expect(d.start).not.toHaveBeenCalled();
  });

  it("never marks it for a member, with the switch off, or without the brand record", async () => {
    const d = deps();
    expect(await markWelcomeShown(MEMBER, NEW_BRAND, d)).toBe(false);
    expect(await markWelcomeShown(ADMIN, null, d)).toBe(false);
    delete process.env.ONBOARDING_ENABLED;
    expect(await markWelcomeShown(ADMIN, NEW_BRAND, d)).toBe(false);
    expect(d.start).not.toHaveBeenCalled();
  });

  it("treats an unknown count as a busy brand, and fails soft", async () => {
    const unknown = deps({ recordsEver: null, signups: 0 });
    expect(await markWelcomeShown(ADMIN, NEW_BRAND, unknown)).toBe(false);
    expect(unknown.start).not.toHaveBeenCalled();
    const failing = { loadSignals: vi.fn().mockRejectedValue(new Error("down")) as never, start: vi.fn() };
    expect(await markWelcomeShown(ADMIN, NEW_BRAND, failing)).toBe(false);
    const writeFails = { loadSignals: deps().loadSignals, start: vi.fn().mockRejectedValue(new Error("contention")) };
    expect(await markWelcomeShown(ADMIN, NEW_BRAND, writeFails)).toBe(false);
  });
});
