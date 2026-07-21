import { GoogleGenAI, Modality } from "@google/genai";
import { TEXT_MODEL, IMAGE_MODEL, CAROUSEL_IMAGE_MODEL, BLOCK_IMAGE_MODEL, EBOOK_IMAGE_MODEL } from "./modelConfig";

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
 * Stream text token-by-token from a prompt. Yields incremental text chunks (the SDK's
 * `generateContentStream`). The ONLY streaming generation in the app — used by the eBook
 * studio to render a chapter as it's written. Yields nothing when Gemini is unconfigured
 * or the stream errors (callers fall back to the non-streaming `generateText`). Never
 * throws — the async generator just ends.
 */
export async function* generateTextStream(prompt: string): AsyncGenerator<string> {
  const ai = getClient();
  if (!ai) return;
  try {
    const stream = await ai.models.generateContentStream({
      model: TEXT_MODEL,
      contents: prompt,
    });
    for await (const chunk of stream) {
      const t = chunk.text;
      if (t) yield t;
    }
  } catch (err) {
    console.warn("[gemini] generateTextStream failed:", err);
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

/**
 * Generate text from a prompt PLUS one inline FILE (multimodal) — e.g. a brand-
 * guidelines PDF (`mimeType: "application/pdf"`). `base64` is the raw base64 (no
 * data: prefix). The total request must stay under ~20MB (callers cap the file).
 * Returns null on missing config / error.
 */
export async function generateTextWithFile(
  prompt: string,
  base64: string,
  mimeType: string,
): Promise<string | null> {
  const ai = getClient();
  if (!ai) return null;
  try {
    const res = await ai.models.generateContent({
      model: TEXT_MODEL,
      contents: [
        { role: "user", parts: [{ text: prompt }, { inlineData: { data: base64, mimeType } }] },
      ],
    });
    return res.text ?? null;
  } catch (err) {
    console.warn("[gemini] generateTextWithFile failed:", err);
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

/**
 * Generate ONE carousel slide via the Gemini image model ("Nano Banana":
 * generateContent with an IMAGE response modality — better than Imagen at rendering
 * legible on-slide text). Null on missing config / error / no image part.
 *
 * NOTE: this path needs live validation once the Vertex carousel image model is
 * provisioned (GEMINI_CAROUSEL_IMAGE_MODEL / GOOGLE_CLOUD_LOCATION=global); until
 * then the carousel feature is flag-gated OFF.
 */
export async function generateSlideImage(
  prompt: string,
): Promise<GeneratedImage | null> {
  const ai = getClient();
  if (!ai) return null;
  try {
    const res = await ai.models.generateContent({
      model: CAROUSEL_IMAGE_MODEL,
      contents: prompt,
      config: { responseModalities: [Modality.TEXT, Modality.IMAGE] },
    });
    for (const part of res.candidates?.[0]?.content?.parts ?? []) {
      const data = part.inlineData?.data;
      if (data) {
        return {
          bytes: Buffer.from(data, "base64"),
          mimeType: part.inlineData?.mimeType ?? "image/png",
        };
      }
    }
    return null;
  } catch (err) {
    console.warn("[gemini] generateSlideImage failed:", err);
    return null;
  }
}

/**
 * Generate an email-layout block image via the Gemini "Nano Banana" image model
 * (generateContent + IMAGE modality; env-overridable BLOCK_IMAGE_MODEL). Defaults to a
 * 1:1 aspect ratio (imageConfig.aspectRatio — one of "1:1","2:3","3:2","3:4","4:3",
 * "9:16","16:9","21:9"). Null on missing config / error / no image part.
 */
export async function generateBlockImage(
  prompt: string,
  aspectRatio = "1:1",
): Promise<GeneratedImage | null> {
  const ai = getClient();
  if (!ai) return null;
  try {
    const res = await ai.models.generateContent({
      model: BLOCK_IMAGE_MODEL,
      contents: prompt,
      config: { responseModalities: [Modality.TEXT, Modality.IMAGE], imageConfig: { aspectRatio } },
    });
    for (const part of res.candidates?.[0]?.content?.parts ?? []) {
      const data = part.inlineData?.data;
      if (data) {
        return { bytes: Buffer.from(data, "base64"), mimeType: part.inlineData?.mimeType ?? "image/png" };
      }
    }
    return null;
  } catch (err) {
    console.warn("[gemini] generateBlockImage failed:", err);
    return null;
  }
}

/**
 * Generate OR iteratively edit an eBook image via the edit-capable EBOOK_IMAGE_MODEL
 * (gemini-3.1-flash-image; env GEMINI_EBOOK_IMAGE_MODEL). With no `inputImages` it renders a
 * fresh image from the prompt; with `inputImages` (the prior/uploaded image as inline base64)
 * it edits them per the prompt — image-in → image-out. `aspectRatio` passes straight to
 * imageConfig (the full model natively supports 1:4). Null on missing config / error / no image
 * part. Callers MUST clamp inputImages to the model limits (≤14 images, ≤7 MB each) upstream.
 */
export async function generateEbookImage({
  prompt,
  aspectRatio = "1:1",
  inputImages = [],
  styleRefImages = [],
}: {
  prompt: string;
  aspectRatio?: string;
  inputImages?: { base64: string; mimeType: string }[];
  /**
   * STYLE reference images (brand-style loop, Layer 2). Appended after inputImages so the
   * caller's prompt can distinguish "edit THIS image" (inputImages) from "match the LOOK
   * of these" (styleRefImages). There's no dedicated Gemini styleReference field — the
   * distinction is prompt-driven. Callers must keep the combined image count within the
   * model limit (FULL: ≤14) and each ≤7 MB.
   */
  styleRefImages?: { base64: string; mimeType: string }[];
}): Promise<GeneratedImage | null> {
  const ai = getClient();
  if (!ai) return null;
  try {
    const parts = [
      { text: prompt },
      ...inputImages.map((img) => ({ inlineData: { data: img.base64, mimeType: img.mimeType } })),
      ...styleRefImages.map((img) => ({ inlineData: { data: img.base64, mimeType: img.mimeType } })),
    ];
    const res = await ai.models.generateContent({
      model: EBOOK_IMAGE_MODEL,
      contents: [{ role: "user", parts }],
      config: { responseModalities: [Modality.TEXT, Modality.IMAGE], imageConfig: { aspectRatio } },
    });
    for (const part of res.candidates?.[0]?.content?.parts ?? []) {
      const data = part.inlineData?.data;
      if (data) {
        return { bytes: Buffer.from(data, "base64"), mimeType: part.inlineData?.mimeType ?? "image/png" };
      }
    }
    return null;
  } catch (err) {
    console.warn("[gemini] generateEbookImage failed:", err);
    return null;
  }
}
