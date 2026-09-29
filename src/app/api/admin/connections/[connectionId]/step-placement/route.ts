import { lifecycleAdmin, respond } from "@/lib/connect/admin";
import { getStepPlacement } from "@/lib/connect/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Onboarding steps the product sends somewhere other than where the catalog counts them. */
export async function GET(req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const gate = await lifecycleAdmin(req, { mutate: false });
  if (!gate.ok) return gate.response;
  const { connectionId } = await params;
  return respond(await getStepPlacement(gate.ctx, connectionId));
}
