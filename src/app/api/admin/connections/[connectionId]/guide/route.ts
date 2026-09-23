import { lifecycleAdmin, respond } from "@/lib/connect/admin";
import { forTenant } from "@/lib/tenant";
import { buildIntegrationGuide } from "@/lib/connect/integrationGuide";
import { listRepoAnalyses } from "@/lib/connect/repoAnalysis";
import { docsOrigin } from "@/lib/developers/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** This connection's integration guide: what the customer's developers need to build. */
export async function GET(req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const gate = await lifecycleAdmin(req, { mutate: false });
  if (!gate.ok) return gate.response;
  const { connectionId } = await params;
  const connection = await forTenant(gate.ctx).productConnections.getById(connectionId);
  if (!connection) return respond({ status: 404, body: { error: "not_found" } });
  const analysis = (await listRepoAnalyses(gate.ctx, connectionId)).find((a) => a.map) ?? null;
  return respond({ status: 200, body: { guide: buildIntegrationGuide({ connection, analysis, origin: docsOrigin() }) } });
}
