import { handleSandboxContextRequest } from "@/lib/connect/sandbox";
import { isLifecycleEnabled } from "@/lib/lifecycle/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Sandbox's reference CONTEXT endpoint — what a real product implements.
 * It verifies the platform's signature (direction "context") and returns the
 * test user's steps, facts and insights. No session: auth is the signature.
 */
export async function POST(req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  if (!isLifecycleEnabled()) return Response.json({ error: "lifecycle_disabled" }, { status: 503 });
  const { connectionId } = await params;
  return handleSandboxContextRequest(req, connectionId);
}
