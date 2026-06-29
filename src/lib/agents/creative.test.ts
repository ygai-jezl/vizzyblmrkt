import { describe, it, expect, vi } from "vitest";

// Force the deterministic fallback path regardless of env keys: with the model
// returning nothing, draftCopy degrades to fallbackVariants (source: "fallback").
vi.mock("./gemini", () => ({
  generateText: vi.fn(async () => null),
  generateImage: vi.fn(async () => null),
}));

import { draftCopy } from "./creative";
import type { Campaign } from "@/lib/types/campaign";

function campaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: "c1",
    tenantId: "ten_x",
    waitlistName: "Be the first to get access", // a CTA-style headline
    ...overrides,
  } as unknown as Campaign;
}

function allText(variants: { subject: string; body: string }[]): string {
  return variants.map((v) => `${v.subject} ${v.body}`).join(" ");
}

describe("draftCopy fallback (model unavailable)", () => {
  it("names the product by productName, not the headline", async () => {
    const result = await draftCopy({ campaign: campaign({ productName: "Acme Pro" }), brief: "" });
    expect(result.source).toBe("fallback");
    const text = allText(result.variants);
    expect(text).toContain("Acme Pro");
    expect(text).not.toContain("Be the first to get access");
  });

  it("falls back to the waitlist name when productName is unset", async () => {
    const result = await draftCopy({ campaign: campaign(), brief: "" });
    expect(result.source).toBe("fallback");
    expect(allText(result.variants)).toContain("Be the first to get access");
  });
});
