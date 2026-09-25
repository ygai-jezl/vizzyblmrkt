import { agentFile, JSON_TYPE } from "@/lib/developers/agentDocs";
import { docsOrigin } from "@/lib/developers/flags";
import { jsonSchema } from "@/lib/developers/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The protocol as JSON Schema: events.json, context-request.json, context-response.json, webhook.json. */
export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return agentFile(() => {
    const schema = jsonSchema(name, docsOrigin());
    return schema ? `${JSON.stringify(schema, null, 2)}\n` : null;
  }, JSON_TYPE);
}
