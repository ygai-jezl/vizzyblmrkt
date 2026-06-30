import { GoogleAuth } from "google-auth-library";
import { embeddingLocation, type Region } from "./config";

/**
 * Document-side embeddings (text-embedding-005, 768-dim, RETRIEVAL_DOCUMENT) for
 * the worker. Mirrors src/lib/agents/embeddings.ts but standalone (the worker is
 * an isolated package). REGIONAL endpoint — text-embedding-005 has no `global`.
 */

export const EMBEDDING_MODEL = "text-embedding-005";
export const EMBEDDING_DIM = 768;

// text-embedding-005 request limits (confirmed via Vertex docs): max 20,000 TOTAL
// input tokens per request, max 250 instances, 2,048 tokens per instance.
// autoTruncate only caps each INSTANCE to 2,048 — it does NOT exempt the 20k total,
// so we must pack each request by a token budget, not a fixed instance count.
const EMBED_TOKEN_BUDGET = 18000; // headroom under the 20k hard cap
const EMBED_MAX_INSTANCES = 250;
const PER_INSTANCE_CAP = 2048; // autoTruncate truncates each instance to this

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

  const out: number[][] = [];
  for (const batch of planEmbedBatches(items)) {
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
      throw new Error(`embeddings_${res.status}: ${detail.slice(0, 200)}`);
    }
    const json = (await res.json()) as { predictions?: Array<{ embeddings?: { values?: number[] } }> };
    const preds = json.predictions ?? [];
    if (preds.length !== batch.length) {
      throw new Error(`embeddings_count_mismatch: got ${preds.length} for ${batch.length}`);
    }
    for (const p of preds) {
      const values = p.embeddings?.values;
      if (!Array.isArray(values) || values.length !== EMBEDDING_DIM) {
        throw new Error(`embeddings_bad_dim: expected ${EMBEDDING_DIM}`);
      }
      out.push(values);
    }
  }
  return out;
}
