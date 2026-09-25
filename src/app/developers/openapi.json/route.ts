import { agentFile, JSON_TYPE } from "@/lib/developers/agentDocs";
import { docsOrigin } from "@/lib/developers/flags";
import { openApiSpec } from "@/lib/developers/openapi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** API v2 as OpenAPI 3.1, built from the contract's validators — what /developers/api renders, and what tools load. */
export function GET() {
  return agentFile(() => `${JSON.stringify(openApiSpec(docsOrigin()), null, 2)}\n`, JSON_TYPE);
}
