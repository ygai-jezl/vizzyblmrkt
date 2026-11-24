import { approveRoute } from "@/lib/connectors/signals/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Plan an article from a suggestion your numbers made (CONNECTOR_SIGNALS_ENABLED): admins only,
 * same origin. Body: { workspaceId? }, the programme to write it in. Answers the Create step's
 * link, with the question, page or search filled in.
 */
export async function POST(req: Request, { params }: { params: Promise<{ signalId: string }> }) {
  return approveRoute(req, (await params).signalId);
}
