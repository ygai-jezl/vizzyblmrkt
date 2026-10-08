import { describe, expect, it } from "vitest";
import type { ProductContext } from "@/lib/connect/protocol";
import { resolveField, type RecipientContext } from "./fields";

const NOW = Date.parse("2026-09-25T12:00:00Z");

function rc(context: ProductContext | null): RecipientContext {
  return {
    user: { traits: {}, steps: {}, milestones: {}, consent: null, facts: { share_of_voice: { value: 12, at: "2026-09-25T09:00:00Z" } } },
    catalog: { onboardingSteps: [] },
    context,
    emailsSent: 0,
    enrolledAtMs: NOW,
    nowMs: NOW,
  };
}

describe("fact fields", () => {
  it("use the value the product pushed when there's no live context", () => {
    expect(resolveField("fact.share_of_voice", rc(null))).toBe(12);
  });

  it("prefer the live context's value, and fall back per fact", () => {
    const live = { asOf: "2026-09-25T12:00:00Z", steps: [], facts: [{ id: "share_of_voice", label: "SoV", value: 15 }], insights: [] } as unknown as ProductContext;
    expect(resolveField("fact.share_of_voice", rc(live))).toBe(15);
    const other = { ...live, facts: [{ id: "mentions", label: "Mentions", value: 3 }] } as unknown as ProductContext;
    expect(resolveField("fact.share_of_voice", rc(other))).toBe(12);
  });

  it("stay unknown when nobody sent them", () => {
    expect(resolveField("fact.missing", rc(null))).toBeUndefined();
  });
});

describe("date facts", () => {
  const withDate = (value: unknown, context: ProductContext | null = null): RecipientContext => {
    const base = rc(context);
    return { ...base, user: { ...base.user, facts: { last_active_at: { value: value as string, at: "2026-09-25T09:00:00Z" } } } };
  };
  const live = (value: unknown) =>
    ({ asOf: "2026-09-25T12:00:00Z", steps: [], facts: [{ id: "last_active_at", label: "Last active", value }], insights: [] }) as unknown as ProductContext;

  it("read as whole days since, and until, worked out at the moment of the check", () => {
    expect(resolveField("days_since.last_active_at", withDate("2026-09-11T12:00:00Z"))).toBe(14);
    expect(resolveField("days_since.last_active_at", withDate("2026-09-11T12:00:01Z"))).toBe(13);
    expect(resolveField("days_until.last_active_at", withDate("2026-09-28T09:00:00Z"))).toBe(3);
    expect(resolveField("days_since.last_active_at", { ...withDate("2026-09-11T12:00:00Z"), nowMs: NOW + 86_400_000 })).toBe(15);
  });

  it("prefer the live value, and fall back to the stored one when the live one isn't a date", () => {
    expect(resolveField("days_since.last_active_at", withDate("2026-09-11T12:00:00Z", live("2026-09-24T12:00:00Z")))).toBe(1);
    expect(resolveField("days_since.last_active_at", withDate("2026-09-11T12:00:00Z", live("recently")))).toBe(14);
  });

  it("stay unknown when the value isn't a date, or was never sent", () => {
    expect(resolveField("days_since.last_active_at", withDate("recently"))).toBeUndefined();
    expect(resolveField("days_since.last_active_at", rc(null))).toBeUndefined();
    expect(resolveField("days_until.trial_ends_at", rc(null))).toBeUndefined();
  });
});
