import { GoogleAuth } from "google-auth-library";
import { embeddingLocation, type Region } from "./config";

/**
 * Document-side embeddings (text-embedding-005, 768-dim, RETRIEVAL_DOCUMENT) for
 * the worker. Mirrors src/lib/agents/embeddings.ts but standalone (the worker is
 * an isolated package). REGIONAL endpoint — text-embedding-005 has no `global`.
 */

export const EMBEDDING_MODEL = "text-embedding-005";
export const EMBEDDING_DIM = 768;
const MAX_BATCH = 200;

const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});

export interface EmbedItem {
  title?: string;
  content: string;
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
  for (let i = 0; i < items.length; i += MAX_BATCH) {
    const batch = items.slice(i, i + MAX_BATCH);
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
