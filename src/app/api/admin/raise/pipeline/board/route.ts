import { NextResponse } from "next/server";
import { raiseAdmin } from "@/lib/raise/pipeline/admin";
import { boardRequest } from "@/lib/raise/pipeline/board";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * People › Investors (or Funding), the board (RAISE_PIPELINE_ENABLED): every Stage with its count and
 * cards, newest 300 a stage. Anyone on the team reads it; `canMove` says whether this user can move
 * people. `{ setUp: false }` while the brand has no Stage field.
 */
export async function GET(req: Request) {
  const gate = await raiseAdmin(req, { mutate: false });
  if (!gate.ok) return gate.response;
  const r = await boardRequest(gate.ctx);
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
