import { run } from "./pipeline";

/**
 * Cloud Run Job entrypoint. Reads the ticket coordinates from env (set as a
 * per-execution containerOverride by /api/admin/knowledge/ingest), runs the
 * ingest→chunk→embed→write pipeline, and updates the ticket. Exit non-zero on
 * failure so Cloud Run records the execution as failed (the pipeline has already
 * marked the ticket "failed" with lastError before this rethrows).
 */
run()
  .then(() => {
    console.log("[knowledge-scraper] ingestion complete");
    process.exit(0);
  })
  .catch((err) => {
    console.error("[knowledge-scraper] ingestion failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
