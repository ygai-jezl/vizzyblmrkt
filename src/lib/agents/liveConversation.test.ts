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

  it("defaults the model to the Gemini 3.1 Flash Live preview id", () => {
    expect(LIVE_MODEL).toBe("gemini-3.1-flash-live-preview");
  });
});
