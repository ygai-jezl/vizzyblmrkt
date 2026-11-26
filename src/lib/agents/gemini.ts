import { GoogleGenAI, Modality } from "@google/genai";
import { TEXT_MODEL, IMAGE_MODEL, CAROUSEL_IMAGE_MODEL, EBOOK_IMAGE_MODEL } from "./modelConfig";

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
      location: process.env.GOOGLE_CLOUD_LOCATION ?? "global",
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

/** How much a call may "think" before it answers, in tokens. Thinking is most of a long
 *  call's time, so a caller that has to return soon caps it. */
export interface ThinkingOptions {
  thinkingBudget?: number;
}

function thinkingConfig(opts: ThinkingOptions): { thinkingConfig: { thinkingBudget: number } } | Record<string, never> {
  return opts.thinkingBudget !== undefined ? { thinkingConfig: { thinkingBudget: opts.thinkingBudget } } : {};
}

/**
 * Generate text, or null on missing config / error. With a `thinkingBudget`, a model that
 * won't take the setting (models change — see modelConfig.ts) is asked again without it,
 * so the cap can only ever make a call faster, never make it fail.
 */
export async function generateText(prompt: string, opts: ThinkingOptions & { usage: AiUsage }): Promise<string | null> {
  const ai = getClient();
  if (!ai) return null;
  try {
    if (opts.thinkingBudget !== undefined) {
      try {
        const capped = await ai.models.generateContent({ model: TEXT_MODEL, contents: prompt, config: thinkingConfig(opts) });
        await recordModel(opts.usage, capped, TEXT_MODEL);
        return capped.text ?? null;
      } catch (err) {
        await recordLost(opts.usage, TEXT_MODEL);
        console.warn(
          "[gemini] generateText with a thinking budget failed; retrying without it:",
          err instanceof Error ? err.message.slice(0, 200) : "error",
        );
      }
    }
    const res = await ai.models.generateContent({
      model: TEXT_MODEL,
      contents: prompt,
    });
    await recordModel(opts.usage, res, TEXT_MODEL);
    return res.text ?? null;
  } catch (err) {
    await recordLost(opts.usage, TEXT_MODEL);
    console.warn("[gemini] generateText failed:", err);
    return null;
  }
}

/**
 * Generate text within a hard deadline — ONE attempt, aborted client-side when
 * the deadline passes. Null on timeout, missing config or any error, so callers
 * fall back to deterministic content. `json` asks for a JSON response;
 * `thinkingBudget` caps how long the model reasons first (one attempt still: a
 * model that rejects the setting returns null like any other error).
 */
export async function generateTextWithDeadline(
  prompt: string,
  opts: { timeoutMs: number; json?: boolean; temperature?: number; usage: AiUsage } & ThinkingOptions,
): Promise<string | null> {
  const ai = getClient();
  if (!ai) return null;
  const signal = AbortSignal.timeout(opts.timeoutMs);
  try {
    const res = await Promise.race([
      ai.models.generateContent({
        model: TEXT_MODEL,
        contents: prompt,
        config: {
          abortSignal: signal,
          ...(opts.json ? { responseMimeType: "application/json" } : {}),
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
          ...thinkingConfig(opts),
        },
      }),
      new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("deadline")), { once: true });
      }),
    ]);
    await recordModel(opts.usage, res, TEXT_MODEL);
    return res.text ?? null;
  } catch (err) {
    await recordLost(opts.usage, TEXT_MODEL);
    console.warn(`[gemini] generateTextWithDeadline failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
    return null;
  }
}

/**
 * Structured output within a hard deadline: JSON shaped by `schema`, a JSON Schema the API takes as
 * responseJsonSchema (enums hold the model to a list; keep item counts out of it, since Vertex has
 * refused capped schemas, and check counts in code). Null on timeout, missing config or any error,
 * so callers fall back. When the API refuses the schema as written (a 400: nothing ran and nothing
 * was billed), it asks once more in plain JSON mode within the same deadline, so callers check the
 * answer themselves either way.
 */
export async function generateJsonWithSchema(
  prompt: string,
  opts: { schema: Record<string, unknown>; timeoutMs: number; temperature?: number; usage: AiUsage } & ThinkingOptions,
): Promise<string | null> {
  const ai = getClient();
  if (!ai) return null;
  const signal = AbortSignal.timeout(opts.timeoutMs);
  const ask = (withSchema: boolean) =>
    Promise.race([
      ai.models.generateContent({
        model: TEXT_MODEL,
        contents: prompt,
        config: {
          abortSignal: signal,
          responseMimeType: "application/json",
          ...(withSchema ? { responseJsonSchema: opts.schema } : {}),
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
          ...thinkingConfig(opts),
        },
      }),
      new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("deadline")), { once: true });
      }),
    ]);
  try {
    let res: Awaited<ReturnType<typeof ask>>;
    try {
      res = await ask(true);
    } catch (err) {
      if (signal.aborted || !wasRejected(err)) throw err;
      console.warn(`[gemini] the response schema was refused; asking in plain JSON mode: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
      res = await ask(false);
    }
    await recordModel(opts.usage, res, TEXT_MODEL);
    return res.text ?? null;
  } catch (err) {
    await recordLost(opts.usage, TEXT_MODEL);
    console.warn(`[gemini] generateJsonWithSchema failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
    return null;
  }
}

/**
 * Stream text token-by-token from a prompt. Yields incremental text chunks (the SDK's
 * `generateContentStream`). Used by the eBook studio to render a chapter as it's written,
 * and by Vizzy in Edit mode. Yields nothing when Gemini is unconfigured or the stream errors
 * (callers fall back to the non-streaming `generateText`). Never throws — the async generator
 * just ends.
 *
 * `signal` stops the model's work as well as the stream (a closed page, a deadline). With a
 * `thinkingBudget`, a model that won't take the setting is asked again without it, as
 * `generateText` does. Without options the request is as it always was.
 */
export async function* generateTextStream(
  prompt: string,
  opts: { signal?: AbortSignal; usage: AiUsage } & ThinkingOptions,
): AsyncGenerator<string> {
  const ai = getClient();
  if (!ai) return;
  // The last chunk carries the call's whole usage: kept, and told once however the stream ends.
  let last: { usageMetadata?: { totalTokenCount?: number } } | null = null;
  let opened = false;
  const open = (withBudget: boolean) => {
    const config = {
      ...(opts.signal ? { abortSignal: opts.signal } : {}),
      ...(withBudget ? thinkingConfig(opts) : {}),
    };
    return ai.models.generateContentStream({
      model: TEXT_MODEL,
      contents: prompt,
      ...(Object.keys(config).length ? { config } : {}),
    });
  };
  try {
    let stream: Awaited<ReturnType<typeof open>>;
    if (opts.thinkingBudget !== undefined) {
      try {
        stream = await open(true);
      } catch (err) {
        if (opts.signal?.aborted) return;
        console.warn(
          "[gemini] generateTextStream with a thinking budget failed; retrying without it:",
          err instanceof Error ? err.message.slice(0, 200) : "error",
        );
        stream = await open(false);
      }
    } else {
      stream = await open(false);
    }
    opened = true;
    for await (const chunk of stream) {
      if (chunk.usageMetadata) last = chunk;
      if (opts.signal?.aborted) return;
      const t = chunk.text;
      if (t) yield t;
    }
  } catch (err) {
    if (!opts.signal?.aborted) console.warn("[gemini] generateTextStream failed:", err);
  } finally {
    if (last) await recordModel(opts.usage, last, TEXT_MODEL);
    else if (opened || opts.signal?.aborted) await recordLost(opts.usage, TEXT_MODEL);
  }
}

/**
 * Generate text from a prompt PLUS one inline image (multimodal) — used to analyse
 * an Idea Board screenshot. `imageBase64` is the raw base64 (no data: prefix),
 * `mimeType` e.g. "image/png". Total request must stay under 20MB (callers cap the
 * screenshot at 8MB). Returns null on missing config / error. With `timeoutMs`, ONE attempt,
 * given up (and aborted) when the deadline passes, as generateTextWithFile does: the loops' lane
 * profiles an image this way so a slow call never runs past the tick it shares.
 */
export async function generateTextWithImage(
  prompt: string,
  imageBase64: string,
  mimeType: string,
  opts: { timeoutMs?: number; usage: AiUsage },
): Promise<string | null> {
  const ai = getClient();
  if (!ai) return null;
  const signal = opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined;
  try {
    const call = ai.models.generateContent({
      model: TEXT_MODEL,
      contents: [
        { role: "user", parts: [{ text: prompt }, { inlineData: { data: imageBase64, mimeType } }] },
      ],
      ...(signal ? { config: { abortSignal: signal } } : {}),
    });
    const res = signal
      ? await Promise.race([
          call,
          new Promise<never>((_, reject) => {
            signal.addEventListener("abort", () => reject(new Error("deadline")), { once: true });
          }),
        ])
      : await call;
    await recordModel(opts.usage, res, TEXT_MODEL);
    return res.text ?? null;
  } catch (err) {
    await recordLost(opts.usage, TEXT_MODEL);
    console.warn("[gemini] generateTextWithImage failed:", err);
    return null;
  }
}

/**
 * Generate text from a prompt PLUS one inline FILE (multimodal) — e.g. a brand-
 * guidelines PDF (`mimeType: "application/pdf"`). `base64` is the raw base64 (no
 * data: prefix). The total request must stay under ~20MB (callers cap the file).
 * Returns null on missing config / error. With `timeoutMs`, ONE attempt, given up
 * (and aborted) when the deadline passes, so a request with a person waiting ends.
 */
export async function generateTextWithFile(
  prompt: string,
  base64: string,
  mimeType: string,
  opts: { timeoutMs?: number; usage: AiUsage },
): Promise<string | null> {
  const ai = getClient();
  if (!ai) return null;
  const signal = opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined;
  try {
    const call = ai.models.generateContent({
      model: TEXT_MODEL,
      contents: [
        { role: "user", parts: [{ text: prompt }, { inlineData: { data: base64, mimeType } }] },
      ],
      ...(signal ? { config: { abortSignal: signal } } : {}),
    });
    const res = signal
      ? await Promise.race([
          call,
          new Promise<never>((_, reject) => {
            signal.addEventListener("abort", () => reject(new Error("deadline")), { once: true });
          }),
        ])
      : await call;
    await recordModel(opts.usage, res, TEXT_MODEL);
    return res.text ?? null;
  } catch (err) {
    await recordLost(opts.usage, TEXT_MODEL);
    console.warn("[gemini] generateTextWithFile failed:", err instanceof Error ? err.message.slice(0, 200) : "error");
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
  /** The Google searches the call ran (each one is billed). */
  queries: string[];
}

// ---- Usage (USAGE_METER_ENABLED) -------------------------------------------------------------

/** A call that wasn't made: the brand has used this resource (web searches, images) this month. */
export interface UsageLimited {
  limited: true;
  used: number;
  limit: number;
}
/** The name the grounded callers know it by. */
export type SearchLimited = UsageLimited;

/**
 * One call's usage: every Gemini call takes one, so none goes uncounted (a guard test checks only
 * this file calls the model). Built by src/lib/plans/meter.ts (`aiUsage`) and passed in, so this
 * file stays free of storage. It is told the tokens every call used, and checked before and told
 * after any web searches or images a call spends.
 */
export interface AiUsage {
  check(kind: "searches" | "images", units?: number): Promise<UsageLimited | null>;
  /** `lost`: the call failed after it may have used tokens, so they couldn't be counted. */
  recordModel(tokens: number, model: string, opts?: { lost?: boolean }): Promise<void>;
  recordSearches(searches: number, opts?: { lost?: boolean }): Promise<void>;
  recordImages(images: number): Promise<void>;
}

/** Usage that never limits and counts nothing: for tests only (a guard test checks). */
export const NO_USAGE: AiUsage = {
  check: async () => null,
  recordModel: async () => undefined,
  recordSearches: async () => undefined,
  recordImages: async () => undefined,
};

export function isSearchLimited(r: unknown): r is UsageLimited {
  return typeof r === "object" && r !== null && (r as { limited?: unknown }).limited === true;
}
export const isUsageLimited = isSearchLimited;

/** The tokens a response used (prompt, thinking, tools and answer). */
function tokensOf(res: { usageMetadata?: { totalTokenCount?: number } } | null | undefined): number {
  const n = res?.usageMetadata?.totalTokenCount;
  return typeof n === "number" && n > 0 ? n : 0;
}

/** Tell the usage what a call used, never failing the call over it. */
function recordModel(usage: AiUsage, res: { usageMetadata?: { totalTokenCount?: number } } | null | undefined, model: string): Promise<void> {
  return usage.recordModel(tokensOf(res), model).catch(() => undefined);
}

/** A call that failed after it may have used tokens. */
function recordLost(usage: AiUsage, model: string): Promise<void> {
  return usage.recordModel(0, model, { lost: true }).catch(() => undefined);
}

/** Tell the usage how many web searches a call ran, never failing the call over it. */
async function recordSearches(usage: AiUsage, searches: number, lost = false): Promise<void> {
  await usage.recordSearches(searches, lost ? { lost } : undefined).catch(() => undefined);
}

/** Google's search list on a grounded response. */
function searchesOf(meta: { webSearchQueries?: string[] } | undefined | null): string[] {
  return (meta?.webSearchQueries ?? []).filter((q): q is string => typeof q === "string");
}

/** The request was refused as written (a 400), so nothing ran and nothing was billed. */
function wasRejected(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 400) return true;
  const message = err instanceof Error ? err.message : "";
  return /INVALID_ARGUMENT|"code":\s*400|\b400\b/.test(message);
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
  opts: { usage: AiUsage },
): Promise<GroundedJsonResult | SearchLimited | null> {
  const ai = getClient();
  if (!ai) return null;
  const limited = await opts.usage.check("searches");
  if (limited) return limited;
  try {
    const res = await ai.models.generateContent({
      model: TEXT_MODEL,
      contents: prompt,
      config: { tools: [{ googleSearch: {} }] },
    });
    const meta = res.candidates?.[0]?.groundingMetadata;
    const queries = searchesOf(meta);
    await recordSearches(opts.usage, queries.length);
    await recordModel(opts.usage, res, TEXT_MODEL);
    return {
      json: parseFirstJson(res.text ?? ""),
      groundingUsed: meta != null,
      model: TEXT_MODEL,
      queries,
    };
  } catch (err) {
    await recordSearches(opts.usage, 0, true);
    await recordLost(opts.usage, TEXT_MODEL);
    console.warn(
      "[gemini] generateGroundedJson failed:",
      err instanceof Error ? err.message.slice(0, 200) : "error",
    );
    return { json: null, groundingUsed: false, model: TEXT_MODEL, queries: [] };
  }
}

/** A page Google Search returned for a grounded call. `uri` is Google's redirect link
 *  to it (the page's own address is one hop behind it); `domain` is the page's host. */
export interface GroundedSource {
  uri: string;
  title: string;
  domain: string;
}

/** A stretch of the answer and the sources (indexes into `sources`) that back it. */
export interface GroundedSupport {
  text: string;
  /** Byte offsets of the stretch in the answer text, when the API gives them. */
  start: number | null;
  end: number | null;
  sourceIndexes: number[];
}

export interface GroundedTextResult {
  /** The Google searches the call ran (each one is billed). */
  queries: string[];
  text: string;
  sources: GroundedSource[];
  supports: GroundedSupport[];
  model: string;
}

/**
 * Generate text grounded in Google Search AND return what grounded it: the pages search
 * returned and which stretch of the answer each one backs. For callers that must tie a
 * claim to the page it came from (blog research) — the model's own idea of where a fact
 * came from is not evidence; this is. Everything happens within `timeoutMs`. Null when
 * Gemini is unconfigured, times out or errors, so the caller carries on without
 * research. With a `thinkingBudget`, a model that won't take the setting is asked again
 * without it while there is time. Never logs the prompt.
 */
export async function generateGroundedText(
  prompt: string,
  opts: { timeoutMs?: number; usage: AiUsage } & ThinkingOptions,
): Promise<GroundedTextResult | SearchLimited | null> {
  const ai = getClient();
  if (!ai) return null;
  const limited = await opts.usage.check("searches");
  if (limited) return limited;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 45_000);
  const deadline = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("deadline")), { once: true });
  });
  // The race's loser may reject after the call has settled; that is not an error.
  deadline.catch(() => undefined);
  const ask = (capped: boolean) =>
    Promise.race([
      ai.models.generateContent({
        model: TEXT_MODEL,
        contents: prompt,
        config: { tools: [{ googleSearch: {} }], abortSignal: signal, ...(capped ? thinkingConfig(opts) : {}) },
      }),
      deadline,
    ]);
  try {
    // Asked again without the thinking setting only when the request was refused as written: any
    // other failure may have searched (and been billed) already.
    const res = await ask(opts.thinkingBudget !== undefined).catch((err: unknown) => {
      if (opts.thinkingBudget === undefined || signal.aborted || !wasRejected(err)) throw err;
      return ask(false);
    });
    const meta = res.candidates?.[0]?.groundingMetadata;
    const queries = searchesOf(meta);
    await recordSearches(opts.usage, queries.length);
    await recordModel(opts.usage, res, TEXT_MODEL);
    const sources: GroundedSource[] = (meta?.groundingChunks ?? []).map((c) => {
      const web = c.web as { uri?: string; title?: string; domain?: string } | undefined;
      return { uri: web?.uri ?? "", title: web?.title ?? "", domain: web?.domain ?? web?.title ?? "" };
    });
    const supports: GroundedSupport[] = (meta?.groundingSupports ?? []).map((s) => ({
      text: s.segment?.text ?? "",
      start: typeof s.segment?.startIndex === "number" ? s.segment.startIndex : null,
      end: typeof s.segment?.endIndex === "number" ? s.segment.endIndex : null,
      sourceIndexes: (s.groundingChunkIndices ?? []).filter((i) => Number.isInteger(i) && i >= 0 && i < sources.length),
    }));
    return { text: res.text ?? "", sources, supports, model: TEXT_MODEL, queries };
  } catch (err) {
    await recordSearches(opts.usage, 0, true);
    await recordLost(opts.usage, TEXT_MODEL);
    console.warn(
      "[gemini] generateGroundedText failed:",
      err instanceof Error ? err.message.slice(0, 200) : "error",
    );
    return null;
  }
}

export interface UrlRetrieval {
  url: string;
  /** "URL_RETRIEVAL_STATUS_SUCCESS" when Google could read it; anything else means it couldn't. */
  status: string;
}

export interface UrlReadResult {
  text: string;
  /** Each address Google tried to read for the answer, and whether it could. */
  retrieved: UrlRetrieval[];
  model: string;
}

/**
 * Answer with Gemini's URL context tool: Google reads the addresses named in the prompt (from its
 * index first, then live, obeying robots.txt) and the model answers from what it read. Returns
 * which addresses Google could read, so a caller trusts only answers about pages that were
 * actually read. Null when Gemini is unconfigured, times out or errors. With a `thinkingBudget`, a
 * model that won't take the setting is asked again without it while there is time. Never logs the
 * prompt.
 */
export async function readUrlsWithGoogle(
  prompt: string,
  opts: { timeoutMs?: number; usage: AiUsage } & ThinkingOptions,
): Promise<UrlReadResult | null> {
  const ai = getClient();
  if (!ai) return null;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 30_000);
  const deadline = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("deadline")), { once: true });
  });
  // The race's loser may reject after the call has settled; that is not an error.
  deadline.catch(() => undefined);
  const ask = (capped: boolean) =>
    Promise.race([
      ai.models.generateContent({
        model: TEXT_MODEL,
        contents: prompt,
        config: { tools: [{ urlContext: {} }], abortSignal: signal, ...(capped ? thinkingConfig(opts) : {}) },
      }),
      deadline,
    ]);
  try {
    const res = await ask(opts.thinkingBudget !== undefined).catch((err: unknown) => {
      if (opts.thinkingBudget === undefined || signal.aborted || !wasRejected(err)) throw err;
      return ask(false);
    });
    await recordModel(opts.usage, res, TEXT_MODEL);
    const meta = res.candidates?.[0]?.urlContextMetadata?.urlMetadata ?? [];
    const retrieved = meta.map((m) => ({ url: m.retrievedUrl ?? "", status: String(m.urlRetrievalStatus ?? "") }));
    return { text: res.text ?? "", retrieved, model: TEXT_MODEL };
  } catch (err) {
    await recordLost(opts.usage, TEXT_MODEL);
    console.warn("[gemini] readUrlsWithGoogle failed:", err instanceof Error ? err.message.slice(0, 200) : "error");
    return null;
  }
}

export interface GeneratedImage {
  bytes: Buffer;
  mimeType: string;
}

/** The image a response drew, telling the usage about it and the call's tokens. Null when it drew none. */
async function imageOf(
  res: { usageMetadata?: { totalTokenCount?: number }; candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> } }> },
  model: string,
  usage: AiUsage,
): Promise<GeneratedImage | null> {
  await recordModel(usage, res, model);
  for (const part of res.candidates?.[0]?.content?.parts ?? []) {
    const data = part.inlineData?.data;
    if (data) {
      await usage.recordImages(1).catch(() => undefined);
      return { bytes: Buffer.from(data, "base64"), mimeType: part.inlineData?.mimeType ?? "image/png" };
    }
  }
  return null;
}

/**
 * Generate a single square hero image with IMAGE_MODEL (Nano Banana: generateContent + IMAGE
 * modality), or null on missing config / error / no image part. Imagen and its generateImages
 * call were shut down by Google on 2026-08-17; this keeps Imagen's 1:1 shape.
 */
export async function generateImage(
  prompt: string,
  opts: { usage: AiUsage },
): Promise<GeneratedImage | UsageLimited | null> {
  return generateBlockImage(prompt, "1:1", IMAGE_MODEL, opts);
}

/**
 * Generate ONE carousel slide via the Gemini image model ("Nano Banana":
 * generateContent with an IMAGE response modality, good at rendering
 * legible on-slide text). Null on missing config / error / no image part.
 *
 * NOTE: this path needs live validation once the Vertex carousel image model is
 * provisioned (GEMINI_CAROUSEL_IMAGE_MODEL / GOOGLE_CLOUD_LOCATION=global); until
 * then the carousel feature is flag-gated OFF.
 */
export async function generateSlideImage(
  prompt: string,
  opts: { usage: AiUsage },
): Promise<GeneratedImage | UsageLimited | null> {
  const ai = getClient();
  if (!ai) return null;
  const limited = await opts.usage.check("images");
  if (limited) return limited;
  try {
    const res = await ai.models.generateContent({
      model: CAROUSEL_IMAGE_MODEL,
      contents: prompt,
      config: { responseModalities: [Modality.TEXT, Modality.IMAGE] },
    });
    return await imageOf(res, CAROUSEL_IMAGE_MODEL, opts.usage);
  } catch (err) {
    await recordLost(opts.usage, CAROUSEL_IMAGE_MODEL);
    console.warn("[gemini] generateSlideImage failed:", err);
    return null;
  }
}

/**
 * Generate an email-layout block image via the Gemini "Nano Banana" image model
 * (generateContent + IMAGE modality). `aspectRatio` is one of "1:1","2:3","3:2","3:4","4:3",
 * "9:16","16:9","21:9" (imageConfig.aspectRatio). Null on missing config / error / no image part.
 *
 * `model` is the model id for THIS call: callers pass BLOCK_IMAGE_MODEL (modelConfig.ts) or the
 * operator's pick (resolveImageModel / imageModels.ts). Limited at the brand's image cap.
 */
export async function generateBlockImage(
  prompt: string,
  aspectRatio: string,
  model: string,
  opts: { usage: AiUsage },
): Promise<GeneratedImage | UsageLimited | null> {
  const ai = getClient();
  if (!ai) return null;
  const limited = await opts.usage.check("images");
  if (limited) return limited;
  try {
    const res = await ai.models.generateContent({
      model,
      contents: prompt,
      config: { responseModalities: [Modality.TEXT, Modality.IMAGE], imageConfig: { aspectRatio } },
    });
    return await imageOf(res, model, opts.usage);
  } catch (err) {
    await recordLost(opts.usage, model);
    console.warn("[gemini] generateBlockImage failed:", err);
    return null;
  }
}

/**
 * One image within a deadline (the blog hero): Nano Banana at `aspectRatio` and, when given,
 * `imageSize` ("2K"). Aborted when the deadline passes. A model that refuses the size is asked
 * once more without it, inside the same deadline. Null on timeout, missing config, error or no
 * image part.
 */
export async function generateImageWithDeadline(opts: {
  prompt: string;
  aspectRatio: string;
  imageSize?: "1K" | "2K";
  model: string;
  timeoutMs: number;
  usage: AiUsage;
}): Promise<GeneratedImage | UsageLimited | null> {
  const ai = getClient();
  if (!ai) return null;
  const limited = await opts.usage.check("images");
  if (limited) return limited;
  const signal = AbortSignal.timeout(opts.timeoutMs);
  const once = async (withSize: boolean): Promise<GeneratedImage | null> => {
    const res = await Promise.race([
      ai.models.generateContent({
        model: opts.model,
        contents: opts.prompt,
        config: {
          abortSignal: signal,
          responseModalities: [Modality.TEXT, Modality.IMAGE],
          imageConfig: { aspectRatio: opts.aspectRatio, ...(withSize && opts.imageSize ? { imageSize: opts.imageSize } : {}) },
        },
      }),
      new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("deadline")), { once: true });
      }),
    ]);
    return imageOf(res, opts.model, opts.usage);
  };
  try {
    return await once(true);
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (opts.imageSize && !signal.aborted && /image_?size|invalid/i.test(message)) {
      try {
        return await once(false);
      } catch {
        /* fall through */
      }
    }
    await recordLost(opts.usage, opts.model);
    console.warn(`[gemini] generateImageWithDeadline failed: ${message.slice(0, 200)}`);
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
  model = EBOOK_IMAGE_MODEL,
  usage,
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
  /**
   * Override the model id for THIS call (operator model selection — see resolveImageModel /
   * imageModels.ts). Omit to use the default edit-capable full model. NOTE: an edit
   * (`inputImages` set) or `styleRefImages` needs a multimodal-input model — the lite model
   * may return no image part, in which case this degrades to null like any other miss.
   */
  model?: string;
  /** The brand's usage: the image and its tokens are counted, and the image cap is checked first. */
  usage: AiUsage;
}): Promise<GeneratedImage | UsageLimited | null> {
  const ai = getClient();
  if (!ai) return null;
  const limited = await usage.check("images");
  if (limited) return limited;
  try {
    // Image-to-image EDITS (inputImages present) require the edit-capable model. Ignore a
    // non-edit-capable override (e.g. an operator "lite" pick on Customise / eBook Refine) so an
    // edit can't silently no-op on a text-only model. Style references are NOT edits — a
    // styleRef-only generation still honours the chosen model.
    const effectiveModel = inputImages.length > 0 ? EBOOK_IMAGE_MODEL : model;
    const parts = [
      { text: prompt },
      ...inputImages.map((img) => ({ inlineData: { data: img.base64, mimeType: img.mimeType } })),
      ...styleRefImages.map((img) => ({ inlineData: { data: img.base64, mimeType: img.mimeType } })),
    ];
    const res = await ai.models.generateContent({
      model: effectiveModel,
      contents: [{ role: "user", parts }],
      config: { responseModalities: [Modality.TEXT, Modality.IMAGE], imageConfig: { aspectRatio } },
    });
    return await imageOf(res, effectiveModel, usage);
  } catch (err) {
    await recordLost(usage, model);
    console.warn("[gemini] generateEbookImage failed:", err);
    return null;
  }
}
