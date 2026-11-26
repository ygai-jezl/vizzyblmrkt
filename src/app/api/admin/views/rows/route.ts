import { NextResponse } from "next/server";
import { viewsAdmin } from "@/lib/audience/admin";
import { viewRowsRequest } from "@/lib/views/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * People › a view (CRM_VIEWS_ENABLED): up to 50 people by id as rows with the chosen columns,
 * `{ ids, columns }`. Load more and a change of columns read rows here instead of running the
 * view again. Anyone on the team.
 */
export async function POST(req: Request) {
  const gate = await viewsAdmin(req);
  if (!gate.ok) return gate.response;
  const r = await viewRowsRequest(gate.ctx, await req.json().catch(() => null));
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
