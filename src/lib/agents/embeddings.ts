import { GoogleGenAI } from "@google/genai";
import { GoogleAuth } from "google-auth-library";
import type { Region } from "@/lib/types/tenant";
import { EMBEDDING_DIM, EMBEDDING_MODEL } from "@/lib/types/knowledgeBase";

/**
 * Vertex AI text-embedding service (`text-embedding-005`, 768-dim) for the
 * knowledge-RAG pipeline. Mirrors the ADC auth model of agentRuntime.ts (no key
 * files — the App Hosting / Cloud Run runtime service account), NOT gemini.ts:
 *
 *  - text-embedding-005 has NO `global` endpoint (the env GOOGLE_CLOUD_LOCATION
 *    used by the Gemini path is `global` in prod and cannot be used here), so the
 *    :predict call MUST hit a REGIONAL aiplatform endpoint.
 *  - Residency: we pick the embedding location from the tenant's region so the
 *    raw chunk text never leaves its residency region.
 *  - Retrieval quality: embeddings are ASYMMETRIC — documents are embedded with
 *    task_type=RETRIEVAL_DOCUMENT (+ a title), queries with RETRIEVAL_QUERY (or
 *    CODE_RETRIEVAL_QUERY when the query targets code). Mixing these degrades
 *    nearest-neighbour quality, so the two paths are distinct functions.
 *
 * Only the QUERY side lives here (it degrades to null on any failure so retrieval
 * never blocks copy generation). DOCUMENT-side embedding is done by the isolated
 * worker package (workers/knowledge-scraper/src/embed.ts), which throws on failure
 * so the ingestion ticket is marked failed. buildPredictBody/parsePredictResponse
 * are shared shapes the worker mirrors.
 *
 * Two backends (see embeddingBackend):
 *  - Vertex AI (every deployed environment): ADC + GOOGLE_CLOUD_PROJECT, as above.
 *  - Gemini Developer API (a laptop): no real project (unset, or an emulator-only
 *    `demo-*` one) but a classic AI Studio GEMINI_API_KEY. text-embedding-005 is
 *    a Vertex-only model, so this path uses gemini-embedding-001 at the same 768
 *    dimensions (normalised, cosine), which fits the same Firestore vector
 *    indexes. Its vectors are NOT comparable with text-embedding-005 ones, which
 *    is fine on a laptop where every stored vector comes from this path; never
 *    copy laptop vectors into a deployed project.
 */

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

let _auth: GoogleAuth | null = null;
function authClient(): GoogleAuth {
  if (!_auth) _auth = new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
  return _auth;
}

/**
 * Resolve the Vertex location to embed in for a residency region. Overridable
 * per region via env (e.g. to move EU off europe-west4) without a code change.
 * Mirrors the BQ_LOCATION map in src/lib/analytics/bigquery.ts.
 */
export function embeddingLocation(region: Region): string {
  switch (region) {
    case "us":
      return process.env.EMBEDDINGS_LOCATION_US ?? "us-central1";
    case "eu":
      return process.env.EMBEDDINGS_LOCATION_EU ?? "europe-west4";
    case "asia":
      return process.env.EMBEDDINGS_LOCATION_ASIA ?? "asia-southeast1";
    default:
      throw new Error(`No embedding location configured for region '${region}'`);
  }
}

/**
 * The embedding model on the Gemini Developer API path. text-embedding-005 is not
 * served there; this one takes the same task types and a 768-dim output.
 */
export const LOCAL_EMBEDDING_MODEL = "gemini-embedding-001" as const;

export type EmbeddingBackend = "vertex" | "gemini-api";

/**
 * Which backend embeds, or null when none can:
 *  - "vertex" whenever GOOGLE_CLOUD_PROJECT names a real project (unchanged
 *    deployed behaviour: runtime service account + project);
 *  - "gemini-api" when there is no real project (unset, or a `demo-*` emulator
 *    project, which Vertex can't serve) but a classic GEMINI_API_KEY is set and
 *    GOOGLE_GENAI_USE_VERTEXAI isn't "true" (an express key is a Vertex key).
 */
export function embeddingBackend(): EmbeddingBackend | null {
  const project = process.env.GOOGLE_CLOUD_PROJECT?.trim();
  if (project && !project.startsWith("demo-")) return "vertex";
  if (process.env.GEMINI_API_KEY?.trim() && process.env.GOOGLE_GENAI_USE_VERTEXAI !== "true") return "gemini-api";
  return null;
}

/** True once the embedding service can authenticate (deployed: runtime SA + project; laptop: a Gemini key). */
export function isEmbeddingsConfigured(): boolean {
  return embeddingBackend() !== null;
}

/** The regional text-embedding-005 :predict endpoint for a region. */
export function embeddingPredictUrl(region: Region): string {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) throw new Error("embeddings_not_configured");
  const loc = embeddingLocation(region);
  return (
    `https://${loc}-aiplatform.googleapis.com/v1/projects/${project}` +
    `/locations/${loc}/publishers/google/models/${EMBEDDING_MODEL}:predict`
  );
}

/** Retrieval task types (asymmetric). See the module doc + Vertex task-types docs. */
export type EmbeddingTaskType =
  | "RETRIEVAL_DOCUMENT"
  | "RETRIEVAL_QUERY"
  | "CODE_RETRIEVAL_QUERY";

export interface EmbeddingInstanceInput {
  content: string;
  /** Only meaningful for RETRIEVAL_DOCUMENT — improves document embeddings. */
  title?: string;
}

/** Build the :predict request body (pure — unit-tested without network). */
export function buildPredictBody(
  instances: EmbeddingInstanceInput[],
  taskType: EmbeddingTaskType,
): unknown {
  return {
    instances: instances.map((i) => ({
      task_type: taskType,
      // `title` is only valid with RETRIEVAL_DOCUMENT; omit it otherwise.
      ...(taskType === "RETRIEVAL_DOCUMENT" && i.title ? { title: i.title } : {}),
      content: i.content,
    })),
    parameters: { outputDimensionality: EMBEDDING_DIM, autoTruncate: true },
  };
}

/** Parse predictions[].embeddings.values out of a :predict response. */
export function parsePredictResponse(payload: unknown): number[][] {
  const preds = (payload as { predictions?: unknown })?.predictions;
  if (!Array.isArray(preds)) {
    throw new Error("embeddings_bad_response: missing predictions[]");
  }
  return preds.map((p) => {
    const values = (p as { embeddings?: { values?: unknown } })?.embeddings?.values;
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error("embeddings_bad_response: missing embeddings.values");
    }
    return values as number[];
  });
}

/** Max instances per :predict call — the API caps batch size; chunk above this. */
const MAX_BATCH = 200;
/** Max texts per Gemini Developer API batchEmbedContents call. */
const MAX_GEMINI_API_BATCH = 100;

async function predict(
  region: Region,
  instances: EmbeddingInstanceInput[],
  taskType: EmbeddingTaskType,
): Promise<number[][]> {
  if (embeddingBackend() === "gemini-api") return embedWithGeminiApi(instances, taskType);
  const url = embeddingPredictUrl(region);
  const token = await authClient().getAccessToken();
  if (!token) throw new Error("embeddings_no_access_token");

  const out: number[][] = [];
  for (let i = 0; i < instances.length; i += MAX_BATCH) {
    const batch = instances.slice(i, i + MAX_BATCH);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildPredictBody(batch, taskType)),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`embeddings_${res.status}: ${detail.slice(0, 200)}`.trim());
    }
    out.push(...parsePredictResponse(await res.json()));
  }
  return out;
}

let _geminiApi: { key: string; client: GoogleGenAI } | null = null;
function geminiApiClient(): GoogleGenAI {
  const key = process.env.GEMINI_API_KEY?.trim() ?? "";
  if (!_geminiApi || _geminiApi.key !== key) _geminiApi = { key, client: new GoogleGenAI({ apiKey: key }) };
  return _geminiApi.client;
}

/** Scale to unit length: gemini-embedding-001 only normalises its full 3072-dim output. */
export function normalizeVector(values: number[]): number[] {
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  return norm > 0 ? values.map((v) => v / norm) : values;
}

/**
 * The Gemini Developer API path (a laptop with a classic AI Studio key). The
 * request's `title` covers every text in it, so texts are sent in runs that
 * share a title (callers batch with one title anyway).
 */
async function embedWithGeminiApi(
  instances: EmbeddingInstanceInput[],
  taskType: EmbeddingTaskType,
): Promise<number[][]> {
  const titleOf = (i: EmbeddingInstanceInput) => (taskType === "RETRIEVAL_DOCUMENT" ? i.title || undefined : undefined);
  const runs: Array<{ title: string | undefined; contents: string[] }> = [];
  for (const instance of instances) {
    const title = titleOf(instance);
    const last = runs[runs.length - 1];
    if (last && last.title === title && last.contents.length < MAX_GEMINI_API_BATCH) last.contents.push(instance.content);
    else runs.push({ title, contents: [instance.content] });
  }
  const out: number[][] = [];
  for (const run of runs) {
    const res = await geminiApiClient().models.embedContent({
      model: LOCAL_EMBEDDING_MODEL,
      contents: run.contents,
      config: { taskType, outputDimensionality: EMBEDDING_DIM, ...(run.title ? { title: run.title } : {}) },
    });
    const embeddings = res.embeddings ?? [];
    if (embeddings.length !== run.contents.length) {
      throw new Error(`embeddings_bad_response: expected ${run.contents.length} embeddings, got ${embeddings.length}`);
    }
    for (const e of embeddings) {
      const values = e.values;
      if (!Array.isArray(values) || values.length !== EMBEDDING_DIM) {
        throw new Error(`embeddings_bad_response: expected ${EMBEDDING_DIM} values`);
      }
      out.push(normalizeVector(values));
    }
  }
  return out;
}

/**
 * Embed a single DOCUMENT for storage in a vector index (RETRIEVAL_DOCUMENT side of
 * the asymmetric pair — pair with embedQuery at read time). Returns null on missing
 * config / any error so the caller can skip persisting rather than fail. Used by the
 * Distribute performance-exemplar store (which, unlike knowledge_bases, embeds
 * in-app rather than via the scraper worker).
 */
export async function embedDocument(
  text: string,
  region: Region,
  opts: { title?: string } = {},
): Promise<number[] | null> {
  const trimmed = text?.trim();
  if (!trimmed || !isEmbeddingsConfigured()) return null;
  try {
    const [vec] = await predict(region, [{ content: trimmed, title: opts.title }], "RETRIEVAL_DOCUMENT");
    return vec ?? null;
  } catch (err) {
    console.warn(
      "[embeddings] embedDocument failed:",
      err instanceof Error ? err.message.slice(0, 200) : "error",
    );
    return null;
  }
}

/**
 * Embed several DOCUMENTS at once (RETRIEVAL_DOCUMENT), up to 200 to a request: the brand
 * map embeds its subjects and buying situations as they are written or moved. Returns one
 * vector per input, in order; on missing config or any error every slot is null, so the
 * caller skips storing rather than fails.
 */
export async function embedDocuments(
  items: Array<{ content: string; title?: string }>,
  region: Region,
): Promise<Array<number[] | null>> {
  const empty = items.map(() => null);
  const wanted = items.map((it, i) => ({ i, content: it.content?.trim() ?? "", title: it.title })).filter((it) => it.content);
  if (!wanted.length || !isEmbeddingsConfigured()) return empty;
  try {
    const vectors = await predict(region, wanted.map(({ content, title }) => ({ content, title })), "RETRIEVAL_DOCUMENT");
    const out: Array<number[] | null> = [...empty];
    wanted.forEach((it, k) => {
      out[it.i] = vectors[k] ?? null;
    });
    return out;
  } catch (err) {
    console.warn("[embeddings] embedDocuments failed:", err instanceof Error ? err.message.slice(0, 200) : "error");
    return empty;
  }
}

/**
 * Embed a single query for nearest-neighbour retrieval. Uses RETRIEVAL_QUERY, or
 * CODE_RETRIEVAL_QUERY when the query targets code (its corpus side is still
 * RETRIEVAL_DOCUMENT). Returns null on missing config / any error so the caller
 * degrades to no-context instead of failing the user-facing request.
 */
export async function embedQuery(
  text: string,
  region: Region,
  opts: { code?: boolean } = {},
): Promise<number[] | null> {
  const trimmed = text?.trim();
  if (!trimmed || !isEmbeddingsConfigured()) return null;
  try {
    const taskType: EmbeddingTaskType = opts.code
      ? "CODE_RETRIEVAL_QUERY"
      : "RETRIEVAL_QUERY";
    const [vec] = await predict(region, [{ content: trimmed }], taskType);
    return vec ?? null;
  } catch (err) {
    console.warn(
      "[embeddings] embedQuery failed:",
      err instanceof Error ? err.message.slice(0, 200) : "error",
    );
    return null;
  }
}
