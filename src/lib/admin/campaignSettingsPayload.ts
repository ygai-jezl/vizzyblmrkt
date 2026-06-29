import type { CampaignSettings } from "./campaignSettings";

/** UI representation of a survey question (options edited as one-per-line text). */
export interface UiQuestion {
  id: string;
  question_value: string;
  optional: boolean;
  isChoice: boolean;
  optionsText: string;
}

/**
 * Build the wire payload from the settings editor's local state. The server
 * schema (CampaignSettingsSchema) re-validates and normalises, but we send an
 * explicit "" (NEVER undefined) for cleared optional text fields: a Firestore
 * update() is a merge, so an undefined field is dropped and the stored value
 * survives — only "" actually overwrites it. Pure (no React) so it's unit-testable.
 */
export function buildSettingsPayload(
  form: CampaignSettings,
  questions: UiQuestion[],
  probeTopicsText: string,
): CampaignSettings {
  return {
    ...form,
    waitlistName: form.waitlistName.trim(),
    // Explicit "" (never undefined) so clearing it overwrites the stored value.
    productName: form.productName?.trim() ?? "",
    waitlistUrlLocation: form.waitlistUrlLocation?.trim() ? form.waitlistUrlLocation.trim() : null,
    twitterMessage: form.twitterMessage?.trim() ?? "",
    // Branding (colours, copy, social links) is owned by the Embed & Design tab;
    // pass it straight through so this form never clobbers values that tab owns.
    configurationStyleJson: form.configurationStyleJson,
    strategy: {
      ...form.strategy,
      customToneInstructions: form.strategy.customToneInstructions?.trim() ?? "",
    },
    aiConversation: {
      ...form.aiConversation,
      introLine: form.aiConversation.introLine?.trim() ?? "",
      conversationGoal: form.aiConversation.conversationGoal?.trim() ?? "",
      probeTopics: probeTopicsText
        .split("\n")
        .map((t) => t.trim())
        .filter(Boolean),
    },
    offboardingEmail: {
      ...form.offboardingEmail,
      subject: form.offboardingEmail.subject?.trim() ?? "",
      body: form.offboardingEmail.body?.trim() ?? "",
    },
    questions: questions.map((q) => ({
      question_value: q.question_value.trim(),
      optional: q.optional,
      answer_value: q.isChoice
        ? q.optionsText.split("\n").map((o) => o.trim()).filter(Boolean)
        : null,
    })),
  };
}
