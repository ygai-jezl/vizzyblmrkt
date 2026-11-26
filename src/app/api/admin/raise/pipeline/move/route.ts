import { NextResponse } from "next/server";
import { raiseAdmin } from "@/lib/raise/pipeline/admin";
import { moveRequest } from "@/lib/raise/pipeline/board";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Move one card on the board (RAISE_PIPELINE_ENABLED): `{ personId, to, from, reason? }`. Admins only.
 * Sets Stage through the one field writer with `from` as what the card showed, so a stale board
 * answers 409 `stale` and writes nothing; onto Passed sets or clears Pass reason.
 */
export async function POST(req: Request) {
  const gate = await raiseAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  const r = await moveRequest(gate.ctx, await req.json().catch(() => null));
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
