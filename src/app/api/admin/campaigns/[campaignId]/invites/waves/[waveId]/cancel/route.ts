import { respond } from "@/lib/connect/admin";
import { invitesAdmin } from "@/lib/invites/admin";
import { cancelWave } from "@/lib/invites/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Cancel a wave: invites not yet sent are cancelled. */
export async function POST(req: Request, { params }: { params: Promise<{ campaignId: string; waveId: string }> }) {
  const gate = await invitesAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  const { campaignId, waveId } = await params;
  return respond(await cancelWave(gate.ctx, campaignId, waveId));
}
