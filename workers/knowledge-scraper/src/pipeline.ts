import type { CollectionReference, Firestore } from "firebase-admin/firestore";
import { readEnv, databaseIdForRegion, ownerCollection, type JobEnv } from "./config";
import { getDb, FieldValue } from "./firestore";
import { embedDocuments, EMBEDDING_DIM, EMBEDDING_MODEL } from "./embed";
import { chunkSource, type Chunk } from "./chunk";
import { cloneAndCollect } from "./sources/git";
import { crawlAndCollect } from "./sources/web";
import { fetchGitToken } from "./gitToken";
import { updateTicket } from "./ticket";

const EMBED_WRITE_BATCH = 100;

interface PreparedChunk extends Chunk {
  sourceUri: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Build a citable per-file blob URL for a repo file. */
function blobUrl(repoUrl: string, ref: string | null, path: string): string {
  const base = repoUrl.replace(/\.git$/, "").replace(/\/+$/, "");
  return `${base}/blob/${ref || "HEAD"}/${path}`;
}

async function collectChunks(env: JobEnv): Promise<{ chunks: PreparedChunk[]; pagesProcessed: number }> {
  const chunks: PreparedChunk[] = [];
  if (env.source === "github" || env.source === "gitlab") {
    const { files, filesProcessed } = await cloneAndCollect({
      source: env.source,
      sourceUri: env.sourceUri,
      ref: env.ref,
      includeGlobs: env.includeGlobs,
      token: await fetchGitToken(env.tenantId, env.source),
    });
    for (const f of files) {
      const uri = blobUrl(env.sourceUri, env.ref, f.path);
      for (const c of chunkSource({ text: f.text, sourceUri: uri, path: f.path, isCode: f.isCode, lang: f.lang })) {
        chunks.push({ ...c, sourceUri: uri });
      }
    }
    return { chunks, pagesProcessed: filesProcessed };
  }
  const { pages, pagesProcessed } = await crawlAndCollect({
    sourceUri: env.sourceUri,
    maxPages: env.maxPages,
  });
  for (const p of pages) {
    const path = (() => {
      try {
        return new URL(p.url).pathname;
      } catch {
        return null;
      }
    })();
    for (const c of chunkSource({ text: p.markdown, sourceUri: p.url, path })) {
      chunks.push({ ...c, title: c.heading || p.title, sourceUri: p.url });
    }
  }
  return { chunks, pagesProcessed };
}

/**
 * Prune chunks left over from a PRIOR run of this ticket. Called AFTER the new
 * chunks are written (not before): chunkId is deterministic (`${ticketId}__${i}`),
 * so a re-ingest overwrites chunks 0..keepCount-1 in place; this only removes the
 * stale tail (index >= keepCount) when the new run produced fewer chunks. Running
 * it after the write means a mid-run failure leaves the prior knowledge base
 * intact rather than wiping it. Filters in memory to avoid a composite index.
 */
async function deleteStaleChunks(
  kbRef: CollectionReference,
  ticketId: string,
  keepCount: number,
): Promise<void> {
  const snap = await kbRef.where("ticketId", "==", ticketId).get();
  const stale = snap.docs.filter((d) => {
    const idx = d.get("chunkIndex");
    return typeof idx === "number" && idx >= keepCount;
  });
  for (let i = 0; i < stale.length; i += 400) {
    const wb = kbRef.firestore.batch();
    for (const d of stale.slice(i, i + 400)) wb.delete(d.ref);
    await wb.commit();
  }
}

export async function run(env: JobEnv = readEnv()): Promise<void> {
  const db: Firestore = getDb(databaseIdForRegion(env.region));
  const patch = (p: Record<string, unknown>) => updateTicket(db, env.tenantId, env.ticketId, p);
  // Hoisted so the catch can tell a total failure (0 written) from a partial one.
  let written = 0;

  try {
    await patch({
      status: "running",
      claimedAt: nowIso(),
      startedAt: nowIso(),
      attempts: FieldValue.increment(1),
      lastError: null,
    });

    const { chunks, pagesProcessed } = await collectChunks(env);

    if (chunks.length === 0) {
      // Surface WHY nothing was indexed instead of a bare "done" (0 chunks). The most
      // common web cause is a JavaScript-rendered (SPA) site with no server HTML text.
      const isWeb = env.source !== "github" && env.source !== "gitlab";
      const reason = isWeb
        ? "No indexable text found. This page returned no server-rendered content — it may be JavaScript-rendered (SPA). Try a server-rendered page (e.g. a docs or blog URL), a GitHub/GitLab repo, or paste the text directly."
        : "No indexable text found in the source (after include filters).";
      await patch({
        status: "done",
        chunksWritten: 0,
        pagesProcessed,
        finishedAt: nowIso(),
        lastError: reason,
      });
      return;
    }

    await patch({ status: "embedding", pagesProcessed });

    const kbRef = db
      .collection(ownerCollection(env.ownerKind))
      .doc(env.ownerId)
      .collection("knowledge_bases");

    for (let i = 0; i < chunks.length; i += EMBED_WRITE_BATCH) {
      const slice = chunks.slice(i, i + EMBED_WRITE_BATCH);
      const vectors = await embedDocuments(
        slice.map((c) => ({ title: c.title, content: c.content })),
        env.project,
        env.region,
      );
      const wb = db.batch();
      slice.forEach((c, j) => {
        const chunkIndex = i + j;
        const chunkId = `${env.ticketId}__${chunkIndex}`;
        wb.set(kbRef.doc(chunkId), {
          id: chunkId,
          tenantId: env.tenantId,
          ownerKind: env.ownerKind,
          ownerId: env.ownerId,
          ticketId: env.ticketId,
          source: env.source,
          sourceUri: c.sourceUri,
          title: c.title,
          path: c.path,
          heading: c.heading,
          content: c.content,
          tokenCount: c.tokenCount,
          chunkIndex,
          topic: env.topic,
          tags: env.tags,
          embeddingModel: EMBEDDING_MODEL,
          embeddingDim: EMBEDDING_DIM,
          embedding: FieldValue.vector(vectors[j]),
          createdAt: nowIso(),
        });
      });
      await wb.commit();
      written += slice.length;
      await patch({ chunksWritten: written });
    }

    // New chunks are all written; now prune any stale tail from a prior run.
    await deleteStaleChunks(kbRef, env.ticketId, written);

    await patch({ status: "done", chunksWritten: written, pagesProcessed, finishedAt: nowIso() });
  } catch (err) {
    const msg = err instanceof Error ? err.message.slice(0, 300) : "error";
    // If some chunks were already committed, report "partial" (they are live and
    // retrievable) rather than "failed" (which means no usable output).
    await updateTicket(db, env.tenantId, env.ticketId, {
      status: written > 0 ? "partial" : "failed",
      lastError: msg,
      chunksWritten: written,
      finishedAt: nowIso(),
    }).catch(() => {});
    throw err;
  }
}
