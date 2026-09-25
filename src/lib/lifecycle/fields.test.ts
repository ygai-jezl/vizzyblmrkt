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
