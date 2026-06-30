import { GoogleGenAI } from "@google/genai";

/**
 * Thin Gemini client. Three auth modes (first match wins):
 *  1. Vertex AI Express / Agent Platform — GOOGLE_GENAI_USE_VERTEXAI=true AND a
 *     GEMINI_API_KEY (an "AQ.*" express key): { vertexai: true, apiKey }.
 *  2. Vertex AI via ADC — GOOGLE_GENAI_USE_VERTEXAI=true, no key (deployed envs
 *     use the runtime service account + GOOGLE_CLOUD_PROJECT/LOCATION).
 *  3. Gemini Developer API — a classic "AIza*" GEMINI_API_KEY, no Vertex flag.
 * Returns null when unconfigured so callers degrade gracefully (templated copy /
 * no image) instead of throwing.
 */
const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL ?? "gemini-3.5-flash";
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL ?? "imagen-4.0-generate-001";

let cached: GoogleGenAI | null | undefined;

function getClient(): GoogleGenAI | null {
  if (cached !== undefined) return cached;
  const useVertex = process.env.GOOGLE_GENAI_USE_VERTEXAI === "true";
  const apiKey = process.env.GEMINI_API_KEY;
  if (useVertex && apiKey) {
    // Vertex AI Express: an API key on the Vertex backend (no ADC/project).
    cached = new GoogleGenAI({ vertexai: true, apiKey });
  } else if (useVertex) {
    cached = new GoogleGenAI({
      vertexai: true,
      project: process.env.GOOGLE_CLOUD_PROJECT,
      location: process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1",
    });
  } else if (apiKey) {
    cached = new GoogleGenAI({ apiKey });
  } else {
    cached = null;
  }
  return cached;
}

export function isGeminiConfigured(): boolean {
  return getClient() !== null;
}

let liveCached: GoogleGenAI | null | undefined;

/**
 * Developer-API client used ONLY to mint Live API ephemeral tokens for the
 * post-signup voice conversation. Deliberately SEPARATE from getClient() above:
 * ephemeral tokens and the Live API are Gemini *Developer API*
 * (generativelanguage, v1alpha) features and are NOT supported on the Vertex
 * backend the text/image path uses in prod — so this needs its own
 * `GEMINI_LIVE_API_KEY` (a Gemini Developer-API key from AI Studio). Returns null
 * when unset so the conversation feature degrades off (the token route 503s).
 */
export function getLiveTokenClient(): GoogleGenAI | null {
  if (liveCached !== undefined) return liveCached;
  // A non-empty key enables the feature. We deliberately do NOT match on a key
  // PREFIX: as of 2026 all new Google AI Studio keys are "authorization keys"
  // (bound to a service account, restricted to the Generative Language API by
  // default) and no longer use the legacy "AIza*" format — a prefix check would
  // reject these valid Developer-API keys. The only OFF states are unset/empty or
  // the explicit "disabled" sentinel (App Hosting's yaml validator rejects an
  // empty `value: ""`, so envs without a key use that sentinel instead). A wrong
  // value now surfaces as a logged authTokens.create failure (token route catch)
  // instead of silently degrading off, which is far easier to diagnose.
  const apiKey = process.env.GEMINI_LIVE_API_KEY?.trim();
  const liveEnabled = !!apiKey && apiKey.toLowerCase() !== "disabled";
  // `vertexai: false` is REQUIRED: deployed envs set GOOGLE_GENAI_USE_VERTEXAI=true
  // (for Agent 3), and the SDK would otherwise read that env var and treat THIS
  // client as a Vertex backend — where authTokens.create (ephemeral tokens) is
  // unsupported ("only supported by the Gemini Developer API"). Force Developer API.
  liveCached = liveEnabled
    ? new GoogleGenAI({ vertexai: false, apiKey, httpOptions: { apiVersion: "v1alpha" } })
    : null;
  return liveCached;
}

export function isLiveConfigured(): boolean {
  return getLiveTokenClient() !== null;
}

/** Generate text, or null on missing config / error. */
export async function generateText(prompt: string): Promise<string | null> {
  const ai = getClient();
  if (!ai) return null;
  try {
    const res = await ai.models.generateContent({
      model: TEXT_MODEL,
      contents: prompt,
    });
    return res.text ?? null;
  } catch (err) {
    console.warn("[gemini] generateText failed:", err);
    return null;
  }
}

/**
 * Generate text from a prompt PLUS one inline image (multimodal) — used to analyse
 * an Idea Board screenshot. `imageBase64` is the raw base64 (no data: prefix),
 * `mimeType` e.g. "image/png". Total request must stay under 20MB (callers cap the
 * screenshot at 8MB). Returns null on missing config / error.
 */
export async function generateTextWithImage(
  prompt: string,
  imageBase64: string,
  mimeType: string,
): Promise<string | null> {
  const ai = getClient();
  if (!ai) return null;
  try {
    const res = await ai.models.generateContent({
      model: TEXT_MODEL,
      contents: [
        { role: "user", parts: [{ text: prompt }, { inlineData: { data: imageBase64, mimeType } }] },
      ],
    });
    return res.text ?? null;
  } catch (err) {
    console.warn("[gemini] generateTextWithImage failed:", err);
    return null;
  }
}

/** Extract the first JSON object from model text (tolerates ```json fences/prose). */
export function parseFirstJson(text: string): unknown | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export interface GroundedJsonResult {
  /** Parsed JSON object, or null when the model errored / returned no JSON. */
  json: unknown | null;
  groundingUsed: boolean;
  model: string;
}

/**
 * Generate a grounded (Google Search) JSON response. Returns null only when
 * Gemini is UNCONFIGURED (caller degrades to "unavailable"); a configured-but-
 * failed call returns { json: null } so the caller can distinguish parse/transport
 * failures from missing config. Used by the Market Intelligence Agent (Agent 1).
 * PII-safe: never logs the prompt (it can carry a company domain / sample email).
 */
export async function generateGroundedJson(
  prompt: string,
): Promise<GroundedJsonResult | null> {
  const ai = getClient();
  if (!ai) return null;
  try {
    const res = await ai.models.generateContent({
      model: TEXT_MODEL,
      contents: prompt,
      config: { tools: [{ googleSearch: {} }] },
    });
    const cand = res.candidates?.[0] as { groundingMetadata?: unknown } | undefined;
    return {
      json: parseFirstJson(res.text ?? ""),
      groundingUsed: cand?.groundingMetadata != null,
      model: TEXT_MODEL,
    };
  } catch (err) {
    console.warn(
      "[gemini] generateGroundedJson failed:",
      err instanceof Error ? err.message.slice(0, 200) : "error",
    );
    return { json: null, groundingUsed: false, model: TEXT_MODEL };
  }
}

export interface GeneratedImage {
  bytes: Buffer;
  mimeType: string;
}

/** Generate a single image (Imagen), or null on missing config / error. */
export async function generateImage(
  prompt: string,
): Promise<GeneratedImage | null> {
  const ai = getClient();
  if (!ai) return null;
  try {
    const res = await ai.models.generateImages({
      model: IMAGE_MODEL,
      prompt,
      config: { numberOfImages: 1 },
    });
    const img = res.generatedImages?.[0]?.image;
    if (!img?.imageBytes) return null;
    return {
      bytes: Buffer.from(img.imageBytes, "base64"),
      mimeType: img.mimeType ?? "image/png",
    };
  } catch (err) {
    console.warn("[gemini] generateImage failed:", err);
    return null;
  }
}
