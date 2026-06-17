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
 * backend the text/image path uses in prod — so this needs its own classic
 * `GEMINI_LIVE_API_KEY` ("AIza*"). Returns null when unset so the conversation
 * feature degrades off (the token route 503s and the public CTA stays hidden).
 */
export function getLiveTokenClient(): GoogleGenAI | null {
  if (liveCached !== undefined) return liveCached;
  const apiKey = process.env.GEMINI_LIVE_API_KEY;
  liveCached = apiKey
    ? new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "v1alpha" } })
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
