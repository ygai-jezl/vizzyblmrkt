import { handleSandboxWebhookRequest } from "@/lib/connect/sandbox";
import { isLifecycleEnabled } from "@/lib/lifecycle/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Sandbox's reference WEBHOOK receiver — what a real product implements to
 * mirror preference changes. Verifies the signature (direction "webhook") and
 * keeps the last deliveries in the sandbox's inbox for the UI to show.
 */
export async function POST(req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  if (!isLifecycleEnabled()) return Response.json({ error: "lifecycle_disabled" }, { status: 503 });
  const { connectionId } = await params;
  return handleSandboxWebhookRequest(req, connectionId);
}
