import { describe, it, expect } from "vitest";
import {
  CampaignSettingsSchema,
  toCampaignSettings,
} from "./campaignSettings";
import type { Campaign } from "@/lib/types/campaign";

const VALID: unknown = {
  waitlistName: "Vizzybl Beta",
  waitlistUrlLocation: null,
  spotsToMoveUponReferral: 10,
  usesFirstnameLastname: false,
  usesLeaderboard: true,
  usesSignupVerification: false,
  hideCounts: false,
  removeWidgetHeaders: false,
  requiredContactDetail: "EMAIL",
  questions: [
    { question_value: "What for?", optional: true, answer_value: null },
  ],
  twitterMessage: "I joined!",
  sendEmailCongratulationsOnReferral: true,
  leaderboardLength: 5,
  configurationStyleJson: { widgetButtonColor: "#111827" },
};

describe("CampaignSettingsSchema", () => {
  it("accepts a well-formed settings payload", () => {
    const parsed = CampaignSettingsSchema.safeParse(VALID);
    expect(parsed.success).toBe(true);
  });

  it("rejects unknown fields (no smuggling tenantId/id/createdAt)", () => {
    for (const extra of ["tenantId", "id", "createdAt", "anything"]) {
      const parsed = CampaignSettingsSchema.safeParse({
        ...(VALID as object),
        [extra]: "x",
      });
      expect(parsed.success, `should reject ${extra}`).toBe(false);
    }
  });

  it("rejects an empty waitlist name", () => {
    const parsed = CampaignSettingsSchema.safeParse({
      ...(VALID as object),
      waitlistName: "   ",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects spotsToMoveUponReferral out of 0..1000 and non-integers", () => {
    for (const bad of [-1, 1001, 3.5]) {
      const parsed = CampaignSettingsSchema.safeParse({
        ...(VALID as object),
        spotsToMoveUponReferral: bad,
      });
      expect(parsed.success, `should reject ${bad}`).toBe(false);
    }
  });

  it("rejects an unknown requiredContactDetail value", () => {
    const parsed = CampaignSettingsSchema.safeParse({
      ...(VALID as object),
      requiredContactDetail: "FAX",
    });
    expect(parsed.success).toBe(false);
  });

  it("collapses an empty options array to free-text (answer_value=null)", () => {
    const parsed = CampaignSettingsSchema.safeParse({
      ...(VALID as object),
      questions: [{ question_value: "Q", optional: false, answer_value: [] }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.questions[0]!.answer_value).toBeNull();
    }
  });

  it("keeps and trims non-empty multiple-choice options", () => {
    const parsed = CampaignSettingsSchema.safeParse({
      ...(VALID as object),
      questions: [
        { question_value: "Q", optional: false, answer_value: [" a ", "b"] },
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.questions[0]!.answer_value).toEqual(["a", "b"]);
    }
  });

  it("rejects a question with empty text", () => {
    const parsed = CampaignSettingsSchema.safeParse({
      ...(VALID as object),
      questions: [{ question_value: "  ", optional: false, answer_value: null }],
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts an empty twitterMessage (so an admin can clear the share copy)", () => {
    const parsed = CampaignSettingsSchema.safeParse({ ...(VALID as object), twitterMessage: "" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.twitterMessage).toBe("");
  });

  it("rejects a non-hex widget colour", () => {
    for (const bad of ["red", "#fff", "4937E7", "#GGGGGG"]) {
      const parsed = CampaignSettingsSchema.safeParse({
        ...(VALID as object),
        configurationStyleJson: { widgetButtonColor: bad },
      });
      expect(parsed.success, `should reject colour ${bad}`).toBe(false);
    }
  });

  it("accepts valid hex colours (with or without each colour set)", () => {
    const parsed = CampaignSettingsSchema.safeParse({
      ...(VALID as object),
      configurationStyleJson: {
        widgetBackgroundColor: "#4937E7",
        widgetButtonColor: "#111827",
        widgetFontColor: "#abcdef",
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a configurationStyleJson with socialLinks", () => {
    const parsed = CampaignSettingsSchema.safeParse({
      ...(VALID as object),
      configurationStyleJson: {
        widgetButtonColor: "#111827",
        socialLinks: { twitter: "https://x.com/vizzybl", site: "https://vizzybl.ai" },
      },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.configurationStyleJson.socialLinks).toEqual({
        twitter: "https://x.com/vizzybl",
        site: "https://vizzybl.ai",
      });
    }
  });
});

describe("toCampaignSettings", () => {
  it("projects a stored campaign to its editable settings and round-trips", () => {
    const campaign: Campaign = {
      id: "beta-launch",
      tenantId: "ten_vzb",
      createdAt: "2026-06-15T00:00:00.000Z",
      waitlistName: "Vizzybl Beta",
      waitlistUrlLocation: null,
      spotsToMoveUponReferral: 10,
      usesFirstnameLastname: false,
      usesLeaderboard: true,
      usesSignupVerification: false,
      hideCounts: false,
      removeWidgetHeaders: false,
      requiredContactDetail: "EMAIL",
      questions: [
        { question_value: "What for?", optional: true, answer_value: null },
      ],
      twitterMessage: "I joined!",
      sendEmailCongratulationsOnReferral: true,
      leaderboardLength: 5,
      configurationStyleJson: { widgetButtonColor: "#111827" },
    };
    const settings = toCampaignSettings(campaign);
    // No identity/immutable fields leak into the editable projection.
    expect(settings).not.toHaveProperty("id");
    expect(settings).not.toHaveProperty("tenantId");
    expect(settings).not.toHaveProperty("createdAt");
    // And the projection itself is a valid settings payload.
    expect(CampaignSettingsSchema.safeParse(settings).success).toBe(true);
  });
});
