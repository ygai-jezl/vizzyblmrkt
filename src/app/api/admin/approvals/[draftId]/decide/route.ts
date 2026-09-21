import { lifecycleAdmin, readJson, respond } from "@/lib/connect/admin";
import { decideApproval } from "@/lib/lifecycle/approvals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Approve (optionally edited — re-validated, 422 on failure), use the standard
 * version, or skip. Admins only; 409 if the draft moved on or the window closed.
 */
export async function POST(req: Request, { params }: { params: Promise<{ draftId: string }> }) {
  const gate = await lifecycleAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  return respond(await decideApproval(gate.ctx, (await params).draftId, await readJson(req)));
}
