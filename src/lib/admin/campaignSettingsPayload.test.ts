import { describe, it, expect } from "vitest";
import { buildSettingsPayload, type UiQuestion } from "./campaignSettingsPayload";
import { defaultCampaignSettings, type CampaignSettings } from "./campaignSettings";

function form(overrides: Partial<CampaignSettings> = {}): CampaignSettings {
  return { ...defaultCampaignSettings(), ...overrides };
}

describe("buildSettingsPayload", () => {
  it("sends an explicit '' (never undefined) for a cleared/unset productName", () => {
    // defaultCampaignSettings omits productName → undefined.
    const unset = buildSettingsPayload(form(), [], "");
    expect("productName" in unset).toBe(true);
    expect(unset.productName).toBe("");

    // Whitespace-only clears to "" too (so the Firestore merge overwrites).
    const blank = buildSettingsPayload(form({ productName: "   " }), [], "");
    expect(blank.productName).toBe("");
  });

  it("trims a set productName", () => {
    const payload = buildSettingsPayload(form({ productName: "  Acme Pro  " }), [], "");
    expect(payload.productName).toBe("Acme Pro");
  });

  it("applies the same explicit-'' clearing to the other optional text fields", () => {
    const payload = buildSettingsPayload(
      form({
        waitlistName: "  Acme Beta  ",
        twitterMessage: "   ",
        waitlistUrlLocation: "   ",
        strategy: { ...defaultCampaignSettings().strategy, customToneInstructions: "  " },
        offboardingEmail: { enabled: true, subject: "  ", body: "  " },
      }),
      [],
      "",
    );
    expect(payload.waitlistName).toBe("Acme Beta");
    expect(payload.twitterMessage).toBe("");
    expect(payload.waitlistUrlLocation).toBeNull(); // blank URL → null, not ""
    expect(payload.strategy.customToneInstructions).toBe("");
    expect(payload.offboardingEmail.subject).toBe("");
    expect(payload.offboardingEmail.body).toBe("");
  });

  it("normalises questions and probe topics (trims, drops blanks)", () => {
    const questions: UiQuestion[] = [
      { id: "1", question_value: "  Why?  ", optional: true, isChoice: false, optionsText: "" },
      { id: "2", question_value: "Pick", optional: false, isChoice: true, optionsText: "A\n  \nB " },
    ];
    const payload = buildSettingsPayload(form(), questions, "budget\n\n  timeline  ");
    expect(payload.questions).toEqual([
      { question_value: "Why?", optional: true, answer_value: null },
      { question_value: "Pick", optional: false, answer_value: ["A", "B"] },
    ]);
    expect(payload.aiConversation.probeTopics).toEqual(["budget", "timeline"]);
  });
});
