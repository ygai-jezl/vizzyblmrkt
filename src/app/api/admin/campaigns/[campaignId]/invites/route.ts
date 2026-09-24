import { respond } from "@/lib/connect/admin";
import { invitesAdmin } from "@/lib/invites/admin";
import { getLaunchInvites } from "@/lib/invites/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A launch's invites: the lock, eligible products, the funnel and recent waves. */
export async function GET(req: Request, { params }: { params: Promise<{ campaignId: string }> }) {
  const gate = await invitesAdmin(req, { mutate: false });
  if (!gate.ok) return gate.response;
  const { campaignId } = await params;
  return respond(await getLaunchInvites(gate.ctx, campaignId));
}
