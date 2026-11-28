import { raiseReader, versionFromRequest } from "@/lib/raise/docs/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One kept version of a deck, with its checks. Any member. */
export async function GET(req: Request, { params }: { params: Promise<{ docId: string; n: string }> }) {
  const g = await raiseReader(req);
  if (!g.ok) return g.response;
  const { docId, n } = await params;
  return versionFromRequest(g.ctx, docId, n);
}
