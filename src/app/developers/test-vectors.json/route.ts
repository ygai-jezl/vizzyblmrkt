import { agentFile, JSON_TYPE } from "@/lib/developers/agentDocs";
import vectors from "../../../../sdk/node/test/vectors.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The shared signing test vectors (the same file the SDK and platform tests pin), for any language. */
export function GET() {
  return agentFile(() => `${JSON.stringify(vectors, null, 2)}\n`, JSON_TYPE);
}
