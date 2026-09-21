import { handleIngestRequest } from "@/lib/connect/ingestHttp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Product event ingest (identify/track batches) for connected products.
 * Server-to-server only: each request is signed with the connection's secret
 * (see src/lib/connect/protocol.ts and src/lib/connect/ingestHttp.ts). There are
 * deliberately no CORS headers — calling it from a browser would leak the secret.
 */
export async function POST(req: Request) {
  return handleIngestRequest(req);
}
