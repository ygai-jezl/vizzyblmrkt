import { describe, it, expect } from "vitest";
import {
  normalizeEmail,
  deterministicSignupId,
  generateReferralToken,
} from "./identifiers";

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  Foo@Bar.COM ")).toBe("foo@bar.com");
  });
});

describe("deterministicSignupId", () => {
  it("is stable for the same campaign + contact (idempotency key)", () => {
    expect(deterministicSignupId("camp1", "a@b.com")).toBe(
      deterministicSignupId("camp1", "A@B.com "),
    );
  });
  it("differs across campaigns and across contacts", () => {
    expect(deterministicSignupId("camp1", "a@b.com")).not.toBe(
      deterministicSignupId("camp2", "a@b.com"),
    );
    expect(deterministicSignupId("camp1", "a@b.com")).not.toBe(
      deterministicSignupId("camp1", "c@d.com"),
    );
  });
  it("is prefixed and bounded", () => {
    expect(deterministicSignupId("camp1", "a@b.com")).toMatch(/^sig_[0-9a-f]{40}$/);
  });
});

describe("generateReferralToken", () => {
  it("produces unambiguous fixed-length tokens", () => {
    const t = generateReferralToken();
    expect(t).toHaveLength(9);
    expect(t).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/);
  });
  it("is effectively unique across calls", () => {
    const set = new Set(Array.from({ length: 500 }, () => generateReferralToken()));
    expect(set.size).toBe(500);
  });
});
