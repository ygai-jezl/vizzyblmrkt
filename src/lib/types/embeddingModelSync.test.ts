import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { EMBEDDING_MODEL, EMBEDDING_DIM } from "./knowledgeBase";

/**
 * Drift guard for the embedding model. The knowledge-scraper worker is an isolated
 * package that CANNOT import the app's source of truth (this file), so it keeps its
 * OWN copy of the embedding model id + dimension in
 * workers/knowledge-scraper/src/embed.ts. This test reads that worker source as
 * text and asserts its literals still match the app's pinned constants.
 *
 * If they diverge, document-side (worker) and query-side (app) embeddings would use
 * different models/dimensions — silently corrupting `.findNearest()` retrieval — so
 * we fail the build here instead. (The embedding model is pinned on purpose:
 * changing it is a re-embed migration, not a config change. See knowledgeBase.ts.)
 */
const workerEmbedSrc = readFileSync(
  fileURLToPath(
    new URL("../../../workers/knowledge-scraper/src/embed.ts", import.meta.url),
  ),
  "utf8",
);

describe("embedding model ⟷ worker sync", () => {
  it("worker EMBEDDING_MODEL matches the app's pinned constant", () => {
    const match = workerEmbedSrc.match(/\bEMBEDDING_MODEL\s*=\s*["']([^"']+)["']/);
    expect(match?.[1]).toBe(EMBEDDING_MODEL);
  });

  it("worker EMBEDDING_DIM matches the app's pinned constant", () => {
    const match = workerEmbedSrc.match(/\bEMBEDDING_DIM\s*=\s*(\d+)/);
    expect(Number(match?.[1])).toBe(EMBEDDING_DIM);
  });
});
