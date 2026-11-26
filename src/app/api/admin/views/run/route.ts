import { NextResponse } from "next/server";
import { viewsAdmin } from "@/lib/audience/admin";
import { runViewRequest } from "@/lib/views/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * People › a view (CRM_VIEWS_ENABLED): run one. `{ definition, q? }` answers the count, the group it
 * read and that group's total, `capped` when only its 5,000 most recently active were checked, every
 * match in order, and the first 50 rows. Anyone on the team. 429 `views_busy` when two runs are
 * already going on this instance.
 */
export async function POST(req: Request) {
  const gate = await viewsAdmin(req);
  if (!gate.ok) return gate.response;
  const r = await runViewRequest(gate.ctx, await req.json().catch(() => null));
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
