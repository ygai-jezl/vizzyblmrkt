import { lifecycleAdmin, respond } from "@/lib/connect/admin";
import { countWaitingApprovals } from "@/lib/lifecycle/approvals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How many AI lines are waiting — the sidebar badge. */
export async function GET(req: Request) {
  const gate = await lifecycleAdmin(req, { mutate: false });
  if (!gate.ok) return gate.response;
  return respond({ status: 200, body: { count: await countWaitingApprovals(gate.ctx) } });
}
