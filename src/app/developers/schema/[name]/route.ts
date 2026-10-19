import { agentFile, JSON_TYPE } from "@/lib/developers/agentDocs";
import { docsOrigin } from "@/lib/developers/flags";
import { originFromHeaders } from "@/lib/http/origin";
import { jsonSchema } from "@/lib/developers/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The API as JSON Schema, one file per message — the names are in SCHEMAS (src/lib/developers/schemas.ts). */
export async function GET(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return agentFile(() => {
    const schema = jsonSchema(name, docsOrigin(originFromHeaders(req.headers)));
    return schema ? `${JSON.stringify(schema, null, 2)}\n` : null;
  }, JSON_TYPE);
}
