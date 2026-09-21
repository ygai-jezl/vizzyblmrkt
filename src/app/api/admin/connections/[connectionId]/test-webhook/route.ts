import { lifecycleAdmin, respond } from "@/lib/connect/admin";
import { testWebhook } from "@/lib/connect/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Send one signed test webhook to the product's webhook endpoint. */
export async function POST(req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const gate = await lifecycleAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  const { connectionId } = await params;
  return respond(await testWebhook(gate.ctx, connectionId));
}
