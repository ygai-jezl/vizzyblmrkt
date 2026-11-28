import { deleteFromRequest, raiseAdmin, raiseReader, readFromRequest, saveFromRequest } from "@/lib/raise/docs/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ docId: string }> };

/** One deck, with its checks, talk time, versions and look. Any member. */
export async function GET(req: Request, { params }: Params) {
  const g = await raiseReader(req);
  if (!g.ok) return g.response;
  return readFromRequest(g.ctx, (await params).docId);
}

/** Save a change as a new version, from the version it was made on. Admins. */
export async function PUT(req: Request, { params }: Params) {
  const g = await raiseAdmin(req);
  if (!g.ok) return g.response;
  return saveFromRequest(g.ctx, (await params).docId, await req.json().catch(() => null));
}

/** Delete the deck and every version. Admins. */
export async function DELETE(req: Request, { params }: Params) {
  const g = await raiseAdmin(req);
  if (!g.ok) return g.response;
  return deleteFromRequest(g.ctx, (await params).docId);
}
