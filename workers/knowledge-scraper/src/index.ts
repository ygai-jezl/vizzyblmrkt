import { run } from "./pipeline";
import { runProductMap } from "./productMap/run";

/**
 * Cloud Run Job entrypoint. Reads the ticket coordinates from env (set as a
 * per-execution containerOverride by /api/admin/knowledge/ingest), runs the
 * ingest→chunk→embed→write pipeline, and updates the ticket. Exit non-zero on
 * failure so Cloud Run records the execution as failed (the pipeline has already
 * marked the ticket "failed" with lastError before this rethrows).
 */
// One image, two jobs: JOB_KIND=product_map runs repo analysis ("Learn from
// your repo"); anything else is knowledge ingestion.
const productMap = process.env.JOB_KIND === "product_map";
(productMap ? runProductMap() : run())
  .then(() => {
    console.log(`[knowledge-scraper] ${productMap ? "product map" : "ingestion"} complete`);
    process.exit(0);
  })
  .catch((err) => {
    // Messages are already credential-scrubbed by the clone layer.
    console.error(`[knowledge-scraper] ${productMap ? "product map" : "ingestion"} failed:`, err instanceof Error ? err.message : err);
    process.exit(1);
  });
