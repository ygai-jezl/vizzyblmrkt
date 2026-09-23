import { lifecycleAdmin, readJson, respond } from "@/lib/connect/admin";
import { listRepoAnalyses, startRepoAnalysis } from "@/lib/connect/repoAnalysis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ connectionId: string }> };

/** Recent "Learn from your repo" runs for this connection, newest first, with their product maps. */
export async function GET(req: Request, { params }: Params) {
  const gate = await lifecycleAdmin(req, { mutate: false });
  if (!gate.ok) return gate.response;
  const analyses = await listRepoAnalyses(gate.ctx, (await params).connectionId);
  return respond({ status: 200, body: { analyses } });
}

/** Start a read-only analysis of up to 3 repos ({ repos: [{ url, ref? }] }). */
export async function POST(req: Request, { params }: Params) {
  const gate = await lifecycleAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  const r = await startRepoAnalysis(gate.ctx, (await params).connectionId, await readJson(req));
  return respond(r.ok ? { status: 202, body: r.value } : { status: r.status, body: { error: r.error, detail: r.detail } });
}
