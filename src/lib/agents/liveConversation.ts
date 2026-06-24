import { Modality, type LiveConnectConfig } from "@google/genai";
import {
  languageDirective,
  liveCodeFor,
  resolveCampaignLocale,
} from "@/lib/i18n/locale";
import { renderPrompt } from "./prompts/registry";
import type { Campaign } from "@/lib/types/campaign";

/**
 * Post-signup Gemini Live voice conversation: the per-launch system instruction
 * + the locked session config. Server-only — the system prompt is baked into the
 * ephemeral token via `liveConnectConstraints` and never reaches the browser.
 */

/** The Gemini Live model for the conversation. Overridable per environment. */
export const LIVE_MODEL =
  process.env.GEMINI_LIVE_MODEL ?? "gemini-3.1-flash-live-preview";

/**
 * Native-audio Live models (our default) switch language naturally and REJECT
 * `speech_config.language_code` — they're steered purely by the system instruction.
 * Half-cascade models accept `language_code` and steer better with it. We default
 * to native-audio (the safe choice) and only set `language_code` for a model in the
 * known-cascaded allow-list, so a `GEMINI_LIVE_MODEL` override can't error the session.
 */
function isCascadedLiveModel(model: string): boolean {
  return model.startsWith("gemini-live-2.5-flash") && !model.includes("native-audio");
}

/**
 * Build the spoken-conversation system instruction from the campaign's strategy
 * (brand tone / audience / goal) and its `aiConversation` config (goal + probe
 * topics), with sensible fallbacks so a sparsely-configured launch still runs.
 *
 * `locale` (base code, e.g. "fr") steers the spoken language via a system-prompt
 * directive — the only lever for the native-audio Live model, which cannot take
 * `speech_config.language_code`. Defaults to the launch's resolved locale.
 */
export function buildLiveSystemInstruction(campaign: Campaign, locale?: string): string {
  const s = campaign.strategy;
  const c = campaign.aiConversation;
  const topics = (c?.probeTopics ?? []).map((t) => `- ${t}`).join("\n");
  const lang = locale ?? resolveCampaignLocale(campaign);
  return renderPrompt("conversation.golden_data", {
    waitlist_name: campaign.waitlistName,
    response_language_directive: languageDirective(lang),
    conversation_goal:
      c?.conversationGoal?.trim() ||
      "Understand why this person joined the waitlist and what problem they want solved.",
    brand_tone: s?.brandTone ?? "PRODUCT_LED_CASUAL",
    target_audience: s?.targetAudience ?? "GENERAL_CONSUMERS",
    campaign_goal: s?.campaignGoal ?? "PRE_LAUNCH_WAITLIST",
    custom_tone: s?.customToneInstructions?.trim() ?? "",
    probe_topics:
      topics ||
      "- Why they signed up\n- What they use today\n- What would make this a must-have",
  });
}

/**
 * The Live session config locked into the ephemeral token. Voice in/out, with
 * input + output transcription enabled so the spoken conversation is captured as
 * text ("golden data"). `sessionResumption` lets a longer call reconnect past the
 * per-session time cap.
 */
export function buildLiveConnectConfig(campaign: Campaign, locale?: string): LiveConnectConfig {
  const lang = locale ?? resolveCampaignLocale(campaign);
  const liveCode = liveCodeFor(lang);
  // BCP-47 hint biases the transcription toward the spoken language (better
  // golden-data accuracy); absent ⇒ the server auto-detects, as before.
  const transcription = liveCode ? { languageCodes: [liveCode] } : {};

  const config: LiveConnectConfig = {
    responseModalities: [Modality.AUDIO],
    systemInstruction: buildLiveSystemInstruction(campaign, lang),
    inputAudioTranscription: transcription,
    outputAudioTranscription: transcription,
    sessionResumption: {},
  };

  // Half-cascade models steer better with an explicit language code; native-audio
  // models reject it (we steer those via the system instruction instead).
  // SpeechConfig.languageCode is ISO 639-1 (the base `lang`, e.g. "fr"); the
  // region-tagged `liveCode` (fr-FR) is for the transcription hint only.
  if (liveCode && isCascadedLiveModel(LIVE_MODEL)) {
    config.speechConfig = { languageCode: lang };
  }
  return config;
}
