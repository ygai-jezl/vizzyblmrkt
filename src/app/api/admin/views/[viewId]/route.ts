import { NextResponse } from "next/server";
import { viewsAdmin } from "@/lib/audience/admin";
import { changeViewRequest, removeViewRequest } from "@/lib/views/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };

/**
 * One saved view (CRM_VIEWS_ENABLED). PATCH `{ version, name?, definition? }` changes it from the
 * version it was opened at (409 `view_changed` when someone changed it since), and
 * `{ version, archived: false }` brings an archived team view back. Team views: admins only.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ viewId: string }> }) {
  const gate = await viewsAdmin(req);
  if (!gate.ok) return gate.response;
  const { viewId } = await params;
  const r = await changeViewRequest(gate.ctx, viewId, await req.json().catch(() => null));
  return NextResponse.json(r.body, { status: r.status, headers: noStore });
}

/** `{ version }`: archives a team view (admins; it can be brought back), or deletes an Only me view for real. */
export async function DELETE(req: Request, { params }: { params: Promise<{ viewId: string }> }) {
  const gate = await viewsAdmin(req);
  if (!gate.ok) return gate.response;
  const { viewId } = await params;
  const r = await removeViewRequest(gate.ctx, viewId, await req.json().catch(() => null));
  return NextResponse.json(r.body, { status: r.status, headers: noStore });
}
