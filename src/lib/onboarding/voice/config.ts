import { Behavior, Modality, Type, type FunctionDeclaration, type LiveConnectConfig } from "@google/genai";
import { fencedContext } from "@/lib/agents/prompts/compose";
import { renderPrompt } from "@/lib/agents/prompts/registry";
import { ONBOARDING_LIMITS } from "@/lib/types/onboarding";
import { PROFILE_CHOICES, PROFILE_KEYS } from "@/lib/types/businessProfile";
import { QUESTIONS } from "../choices";

/**
 * Talk with Vizzy (ONBOARDING_VOICE_ENABLED): the Live session a call runs on, locked into its
 * single-use token on the server (./mint.ts), so the browser can't change the model, the voice,
 * the tools or the instruction. Server only.
 *
 * Left out on purpose: session resumption (the call is shorter than a Live connection),
 * transcription language codes (they fail the Developer API's token), a speech language code
 * (native audio refuses it) and thinking settings (the model refuses them).
 */

/** The call, counted from the open connection. The browser ends it then. */
export const CALL_SECONDS = 300;
/** The token's whole life: the call can't outlast it, whatever the browser does. */
export const TOKEN_SECONDS = ONBOARDING_LIMITS.MAX_CALL_SEC;
/** Time to open the connection after the token is made. */
export const CONNECT_SECONDS = 60;
/** Vizzy's voice ("Warm" in Google's list). */
export const ONBOARDING_VOICE = "Sulafat";

/** Silent notes that tick the topics on screen while they talk. The server's reading after the call is the truth. */
export const NOTE_ANSWER_TOOL: FunctionDeclaration = {
  name: "note_answer",
  behavior: Behavior.NON_BLOCKING,
  description: "Silently note the answer to one of the four topics. Never mention it.",
  parameters: {
    type: Type.OBJECT,
    required: ["topic", "choice"],
    properties: {
      topic: { type: Type.STRING, enum: [...PROFILE_KEYS] },
      choice: { type: Type.STRING, enum: [...PROFILE_KEYS.flatMap((k) => [...PROFILE_CHOICES[k]]), "unclear"] },
      words: { type: Type.STRING, description: "Their own words, at most 25 words." },
    },
  },
};

/** Vizzy ends the call itself, once its goodbye has played. */
export const FINISH_CALL_TOOL: FunctionDeclaration = {
  name: "finish_call",
  behavior: Behavior.NON_BLOCKING,
  description: "Call once, right after your goodbye.",
};

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** The four topics for the instruction, from the same list the questions screen shows. */
export function topicsForInstruction(): string {
  return QUESTIONS.map(
    (q) => `- ${q.key} (${lower(q.short)}): ${q.options.map((o) => `${o.key} (${lower(o.label)})`).join(", ")}`,
  ).join("\n");
}

/** The brand's name, plain and short, with nothing that could close its fence. */
function brandName(name: string): string {
  return name.replace(/[<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "this brand";
}

export function buildOnboardingVoiceInstruction({ brandName: name }: { brandName: string }): string {
  return renderPrompt("onboarding.voice", {
    brand_name: fencedContext("The brand's name", "brand_name", brandName(name)),
    topics: topicsForInstruction(),
  });
}

/** The whole Live config the token locks. */
export function buildOnboardingLiveConfig({ brandName: name }: { brandName: string }): LiveConnectConfig {
  return {
    responseModalities: [Modality.AUDIO],
    systemInstruction: buildOnboardingVoiceInstruction({ brandName: name }),
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: ONBOARDING_VOICE } } },
    tools: [{ functionDeclarations: [NOTE_ANSWER_TOOL, FINISH_CALL_TOOL] }],
  };
}
