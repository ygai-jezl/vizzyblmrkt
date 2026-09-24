import { respond } from "@/lib/connect/admin";
import { invitesAdmin } from "@/lib/invites/admin";
import { sendWave } from "@/lib/invites/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Send a draft wave: one invite per person, queued for sending. */
export async function POST(req: Request, { params }: { params: Promise<{ campaignId: string; waveId: string }> }) {
  const gate = await invitesAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  const { campaignId, waveId } = await params;
  return respond(await sendWave(gate.ctx, campaignId, waveId));
}
