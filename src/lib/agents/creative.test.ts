import { afterEach, describe, it, expect, vi } from "vitest";

// Force the deterministic fallback path regardless of env keys: with the model
// returning nothing, draftCopy degrades to fallbackVariants (source: "fallback").
vi.mock("./gemini", () => ({
  generateText: vi.fn(async () => null),
  generateImage: vi.fn(async () => null),
  NO_USAGE: {},
}));

import { draftCopy } from "./creative";
import { generateText, NO_USAGE } from "./gemini";
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
    const result = await draftCopy({ campaign: campaign({ productName: "Acme Pro" }), brief: "", usage: NO_USAGE });
    expect(result.source).toBe("fallback");
    const text = allText(result.variants);
    expect(text).toContain("Acme Pro");
    expect(text).not.toContain("Be the first to get access");
  });

  it("falls back to the waitlist name when productName is unset", async () => {
    const result = await draftCopy({ campaign: campaign(), brief: "", usage: NO_USAGE });
    expect(result.source).toBe("fallback");
    expect(allText(result.variants)).toContain("Be the first to get access");
  });
});

describe("draftCopy's language (CONTENT_LANGUAGE_ENABLED)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(generateText).mockClear();
  });
  const french = { ...NO_USAGE, brandLanguage: async () => "fr" };
  const lastPrompt = () => String(vi.mocked(generateText).mock.calls.at(-1)?.[0] ?? "");

  it("writes a launch with no language of its own in the brand's", async () => {
    vi.stubEnv("CONTENT_LANGUAGE_ENABLED", "true");
    await draftCopy({ campaign: campaign(), brief: "", usage: french });
    expect(lastPrompt()).toContain("RESPOND ONLY IN French");
  });

  it("keeps a launch's own language", async () => {
    vi.stubEnv("CONTENT_LANGUAGE_ENABLED", "true");
    await draftCopy({ campaign: campaign({ strategy: { defaultLocale: "de" } } as never), brief: "", usage: french });
    expect(lastPrompt()).toContain("RESPOND ONLY IN German");
  });

  it("writes in English as before with the switch off", async () => {
    vi.stubEnv("CONTENT_LANGUAGE_ENABLED", "false");
    await draftCopy({ campaign: campaign(), brief: "", usage: french });
    expect(lastPrompt()).not.toContain("RESPOND ONLY IN");
  });
});
