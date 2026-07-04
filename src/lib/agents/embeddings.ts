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

/** True once the embedding service can authenticate (deployed: runtime SA + project). */
export function isEmbeddingsConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLOUD_PROJECT);
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

async function predict(
  region: Region,
  instances: EmbeddingInstanceInput[],
  taskType: EmbeddingTaskType,
): Promise<number[][]> {
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
