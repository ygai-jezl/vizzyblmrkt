import { lifecycleAdmin, respond } from "@/lib/connect/admin";
import { lookupConnectionUser } from "@/lib/connect/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One user by the product's own id (`?userId=`): state, journeys, opt-outs and latest writes. */
export async function GET(req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const gate = await lifecycleAdmin(req, { mutate: false });
  if (!gate.ok) return gate.response;
  const { connectionId } = await params;
  const userId = new URL(req.url).searchParams.get("userId") ?? "";
  return respond(await lookupConnectionUser(gate.ctx, connectionId, userId));
}
