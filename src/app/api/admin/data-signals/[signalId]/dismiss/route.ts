import { dismissRoute } from "@/lib/connectors/signals/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Dismiss a suggestion your numbers made (CONNECTOR_SIGNALS_ENABLED): admins only, same origin. It stays away 30 days. */
export async function POST(req: Request, { params }: { params: Promise<{ signalId: string }> }) {
  return dismissRoute(req, (await params).signalId);
}
