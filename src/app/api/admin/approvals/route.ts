import { lifecycleAdmin, respond } from "@/lib/connect/admin";
import { listApprovals } from "@/lib/lifecycle/approvals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** AI lines waiting for review (soonest send first), or recently decided (`?view=decided`). */
export async function GET(req: Request) {
  const gate = await lifecycleAdmin(req, { mutate: false });
  if (!gate.ok) return gate.response;
  const view = new URL(req.url).searchParams.get("view") === "decided" ? "decided" : "waiting";
  return respond(await listApprovals(gate.ctx, { view }));
}
