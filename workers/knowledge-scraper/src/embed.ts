import { GoogleAuth } from "google-auth-library";
import { embeddingLocation, type Region } from "./config";

/**
 * Document-side embeddings (text-embedding-005, 768-dim, RETRIEVAL_DOCUMENT) for
 * the worker. Mirrors src/lib/agents/embeddings.ts but standalone (the worker is
 * an isolated package). REGIONAL endpoint — text-embedding-005 has no `global`.
 */

// PINNED, and a MIRROR of the app's source of truth in
// src/lib/types/knowledgeBase.ts (EMBEDDING_MODEL + EMBEDDING_DIM). These two
// literals MUST stay identical to that file — an app-side test
// (src/lib/types/embeddingModelSync.test.ts) reads this file and fails the build
// on drift. The model is deliberately NOT env-overridable: it is coupled to the
// Firestore vector-index dimension (768) and to every already-embedded chunk, so
// changing it is a re-embed migration (new model + rebuilt indexes), never a
// config flip. The worker can't import @/lib, hence the duplicated literal here.
export const EMBEDDING_MODEL = "text-embedding-005";
export const EMBEDDING_DIM = 768;

// text-embedding-005 request limits (confirmed via Vertex docs): max 20,000 TOTAL
// input tokens per request, max 250 instances, 2,048 tokens per instance.
// autoTruncate only caps each INSTANCE to 2,048 — it does NOT exempt the 20k total,
// so we must pack each request by a token budget, not a fixed instance count.
//
// Our estimate is chars/4, which is accurate for prose but UNDER-counts dense
// content like source code (it tokenizes to more tokens per char) — a batch we
// estimate at 18k can really be ~25k and the API rejects it (seen in prod on a
// GitHub repo). So: (1) keep a conservative budget with headroom for ~1.6× under-
// estimation, and (2) embedBatch splits + retries on any size rejection — the real
// safety net, since a single instance is always accepted (autoTruncate caps it).
const EMBED_TOKEN_BUDGET = 12000; // ~1.6× headroom under the 20k hard cap
const EMBED_MAX_INSTANCES = 250;
const PER_INSTANCE_CAP = 2048; // autoTruncate truncates each instance to this

// Embed planned batches with bounded concurrency (Vertex allows healthy QPS; the
// 429/5xx backoff below absorbs the occasional rate-limit). Tunable per env.
const EMBED_CONCURRENCY = Math.max(1, Math.min(16, Number(process.env.KNOWLEDGE_EMBED_CONCURRENCY) || 6));

const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});

export interface EmbedItem {
  title?: string;
  content: string;
}

function estTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/** Effective tokens an instance contributes to the request total (server truncates
 *  to PER_INSTANCE_CAP, so a huge single chunk never blows the budget on its own). */
function itemTokens(it: EmbedItem): number {
  return Math.min(estTokens(it.content) + (it.title ? estTokens(it.title) : 0), PER_INSTANCE_CAP);
}

/**
 * Pack items into request batches that each stay under the per-request token budget
 * and instance cap. A single item is always placed (even if alone it would exceed
 * the budget — autoTruncate caps it server-side). Pure, so it is unit-tested.
 */
export function planEmbedBatches(items: EmbedItem[]): EmbedItem[][] {
  const batches: EmbedItem[][] = [];
  let cur: EmbedItem[] = [];
  let tok = 0;
  for (const it of items) {
    const t = itemTokens(it);
    if (cur.length > 0 && (tok + t > EMBED_TOKEN_BUDGET || cur.length >= EMBED_MAX_INSTANCES)) {
      batches.push(cur);
      cur = [];
      tok = 0;
    }
    cur.push(it);
    tok += t;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

function predictUrl(project: string, region: Region): string {
  const loc = embeddingLocation(region);
  return (
    `https://${loc}-aiplatform.googleapis.com/v1/projects/${project}` +
    `/locations/${loc}/publishers/google/models/${EMBEDDING_MODEL}:predict`
  );
}

/** A 400 that means the request's total input tokens exceeded the per-request cap. */
function isTokenLimitError(status: number, detail: string): boolean {
  return status === 400 && /token count|input token|too many tokens|exceeds the maximum/i.test(detail);
}

// Transient-error backoff: rate limits (429) + server errors (500/503) are retried
// with exponential backoff + jitter so a busy/large ingest doesn't fail the ticket.
const MAX_TRANSIENT_RETRIES = 5;
const BASE_BACKOFF_MS = 600;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Embed ONE planned batch. Two independent recoveries:
 *  - token-limit 400 on a multi-instance batch → split in half + retry each (recurses
 *    to single instances, always accepted via autoTruncate) — self-heals an under-
 *    estimated batch.
 *  - 429 / 5xx → exponential backoff + jitter (transient rate-limit / server blips).
 * Only a non-retryable error (or a single instance that still can't embed) fails the
 * ticket.
 */
async function embedBatch(
  batch: EmbedItem[],
  token: string,
  url: string,
  attempt = 0,
): Promise<number[][]> {
  const body = {
    instances: batch.map((it) => ({
      task_type: "RETRIEVAL_DOCUMENT",
      ...(it.title ? { title: it.title } : {}),
      content: it.content,
    })),
    parameters: { outputDimensionality: EMBEDDING_DIM, autoTruncate: true },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_TRANSIENT_RETRIES) {
      const delay = BASE_BACKOFF_MS * 2 ** attempt + Math.floor(Math.random() * 250);
      await sleep(delay);
      return embedBatch(batch, token, url, attempt + 1);
    }
    if (isTokenLimitError(res.status, detail) && batch.length > 1) {
      const mid = Math.ceil(batch.length / 2);
      const left = await embedBatch(batch.slice(0, mid), token, url);
      const right = await embedBatch(batch.slice(mid), token, url);
      return [...left, ...right];
    }
    throw new Error(`embeddings_${res.status}: ${detail.slice(0, 200)}`);
  }
  const json = (await res.json()) as { predictions?: Array<{ embeddings?: { values?: number[] } }> };
  const preds = json.predictions ?? [];
  if (preds.length !== batch.length) {
    throw new Error(`embeddings_count_mismatch: got ${preds.length} for ${batch.length}`);
  }
  const out: number[][] = [];
  for (const p of preds) {
    const values = p.embeddings?.values;
    if (!Array.isArray(values) || values.length !== EMBEDDING_DIM) {
      throw new Error(`embeddings_bad_dim: expected ${EMBEDDING_DIM}`);
    }
    out.push(values);
  }
  return out;
}

/**
 * Run an async fn over items with a bounded number of in-flight calls, preserving
 * input order in the results. A pool of `limit` workers each pull the next index
 * until exhausted. If any call throws, the rejection propagates (the ticket fails).
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

/** Embed document chunks. Throws on any failure (so the pipeline fails the ticket). */
export async function embedDocuments(
  items: EmbedItem[],
  project: string,
  region: Region,
): Promise<number[][]> {
  if (items.length === 0) return [];
  const token = await auth.getAccessToken();
  if (!token) throw new Error("embeddings_no_access_token");
  const url = predictUrl(project, region);

  // Embed the planned request-batches concurrently (bounded), preserving order.
  const batched = await mapWithConcurrency(planEmbedBatches(items), EMBED_CONCURRENCY, (batch) =>
    embedBatch(batch, token, url),
  );
  return batched.flat();
}
