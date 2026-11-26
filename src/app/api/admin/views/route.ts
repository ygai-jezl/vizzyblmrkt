import { NextResponse } from "next/server";
import { viewsAdmin } from "@/lib/audience/admin";
import { createViewRequest, listViewsRequest } from "@/lib/views/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };

/** People's Views menu (CRM_VIEWS_ENABLED): the team's views, the member's own, and archived team views for admins. */
export async function GET(req: Request) {
  const gate = await viewsAdmin(req);
  if (!gate.ok) return gate.response;
  const r = await listViewsRequest(gate.ctx);
  return NextResponse.json(r.body, { status: r.status, headers: noStore });
}

/** Save view: `{ scope: "team" | "me", name, definition }`. Team views are for admins; anyone keeps their own. */
export async function POST(req: Request) {
  const gate = await viewsAdmin(req);
  if (!gate.ok) return gate.response;
  const r = await createViewRequest(gate.ctx, await req.json().catch(() => null));
  return NextResponse.json(r.body, { status: r.status, headers: noStore });
}
