import { Modality, type LiveConnectConfig } from "@google/genai";
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
 * Build the spoken-conversation system instruction from the campaign's strategy
 * (brand tone / audience / goal) and its `aiConversation` config (goal + probe
 * topics), with sensible fallbacks so a sparsely-configured launch still runs.
 */
export function buildLiveSystemInstruction(campaign: Campaign): string {
  const s = campaign.strategy;
  const c = campaign.aiConversation;
  const topics = (c?.probeTopics ?? []).map((t) => `- ${t}`).join("\n");
  return renderPrompt("conversation.golden_data", {
    waitlist_name: campaign.waitlistName,
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
export function buildLiveConnectConfig(campaign: Campaign): LiveConnectConfig {
  return {
    responseModalities: [Modality.AUDIO],
    systemInstruction: buildLiveSystemInstruction(campaign),
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    sessionResumption: {},
  };
}
