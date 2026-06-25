import { describe, it, expect } from "vitest";
import {
  buildLiveSystemInstruction,
  buildLiveConnectConfig,
  LIVE_MODEL,
} from "./liveConversation";
import type { Campaign } from "@/lib/types/campaign";

function campaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: "c1",
    tenantId: "ten_x",
    waitlistName: "Acme Beta",
    spotsToMoveUponReferral: 10,
    usesFirstnameLastname: false,
    usesLeaderboard: true,
    usesSignupVerification: false,
    hideCounts: false,
    removeWidgetHeaders: false,
    requiredContactDetail: "EMAIL",
    questions: [],
    sendEmailCongratulationsOnReferral: true,
    leaderboardLength: 5,
    configurationStyleJson: {},
    createdAt: "2026-06-15T00:00:00.000Z",
    ...overrides,
  } as Campaign;
}

describe("buildLiveSystemInstruction", () => {
  it("weaves the per-launch context (name, tone, goal, probe topics) into the prompt", () => {
    const prompt = buildLiveSystemInstruction(
      campaign({
        strategy: {
          campaignGoal: "ENTERPRISE_LEAD_GEN",
          targetCount: 100,
          targetAudience: "ENTERPRISE_DECISION_MAKERS",
          brandTone: "BOLD_CHALLENGER",
          customToneInstructions: "Be punchy.",
        },
        aiConversation: {
          enabled: true,
          conversationGoal: "Find out their biggest blocker",
          probeTopics: ["budget", "timeline"],
          leaderboardBonus: 5,
        },
      }),
    );
    expect(prompt).toContain("Acme Beta");
    expect(prompt).toContain("BOLD_CHALLENGER");
    expect(prompt).toContain("ENTERPRISE_DECISION_MAKERS");
    expect(prompt).toContain("Be punchy.");
    expect(prompt).toContain("Find out their biggest blocker");
    expect(prompt).toContain("- budget");
    expect(prompt).toContain("- timeline");
    // No unresolved [[placeholders]] leak through.
    expect(prompt).not.toMatch(/\[\[[\w.]+\]\]/);
  });

  it("falls back to sensible defaults for a sparsely-configured launch", () => {
    const prompt = buildLiveSystemInstruction(campaign());
    expect(prompt).toContain("Acme Beta");
    expect(prompt).toContain("Why they signed up"); // default probe topics
    expect(prompt).not.toMatch(/\[\[[\w.]+\]\]/);
  });

  it("injects a spoken-language directive from the launch's default locale", () => {
    const prompt = buildLiveSystemInstruction(
      campaign({
        strategy: {
          campaignGoal: "PRE_LAUNCH_WAITLIST",
          targetCount: 100,
          targetAudience: "GENERAL_CONSUMERS",
          brandTone: "PRODUCT_LED_CASUAL",
          defaultLocale: "fr",
        } as never,
      }),
    );
    expect(prompt).toContain("RESPOND ONLY IN French");
    expect(prompt).not.toMatch(/\[\[[\w.]+\]\]/);
  });

  it("emits no language directive for an English (default) launch", () => {
    const prompt = buildLiveSystemInstruction(campaign());
    expect(prompt).not.toMatch(/RESPOND ONLY IN/);
  });

  it("honours an explicit per-session locale override", () => {
    const prompt = buildLiveSystemInstruction(campaign(), "ja");
    expect(prompt).toContain("RESPOND ONLY IN Japanese");
  });
});

describe("buildLiveConnectConfig", () => {
  it("locks audio in/out with transcription + resumption", () => {
    const config = buildLiveConnectConfig(campaign());
    expect(config.responseModalities).toEqual(["AUDIO"]);
    expect(typeof config.systemInstruction).toBe("string");
    expect(config.inputAudioTranscription).toBeDefined();
    expect(config.outputAudioTranscription).toBeDefined();
    expect(config.sessionResumption).toBeDefined();
  });

  it("uses an empty transcription config — `languageCodes` errors the Developer-API token mint", () => {
    // `languageCodes` is Vertex/Enterprise-only and is rejected by the Developer-API
    // ephemeral-token mint, so transcription must be an empty `{}` marker regardless of
    // locale. The spoken language is steered by the system instruction instead.
    for (const loc of [undefined, "fr"]) {
      const cfg = buildLiveConnectConfig(campaign(), loc);
      expect(cfg.inputAudioTranscription).toEqual({});
      expect(cfg.outputAudioTranscription).toEqual({});
    }
  });

  it("does NOT set speech_config.language_code on the native-audio default model", () => {
    // The default model is native-audio, which rejects language_code — steering
    // is via the system instruction only.
    expect(buildLiveConnectConfig(campaign(), "fr").speechConfig).toBeUndefined();
  });

  it("defaults the model to the Gemini 3.1 Flash Live preview id", () => {
    expect(LIVE_MODEL).toBe("gemini-3.1-flash-live-preview");
  });
});
