import { lifecycleAdmin, readJson, respond } from "@/lib/connect/admin";
import { acceptProductMap } from "@/lib/connect/repoAnalysis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Add the chosen product-map items to the connection's catalog. */
export async function POST(req: Request, { params }: { params: Promise<{ connectionId: string; analysisId: string }> }) {
  const gate = await lifecycleAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  const { connectionId, analysisId } = await params;
  const r = await acceptProductMap(gate.ctx, connectionId, analysisId, await readJson(req));
  return respond(r.ok ? { status: 200, body: r.value } : { status: r.status, body: { error: r.error, detail: r.detail } });
}
