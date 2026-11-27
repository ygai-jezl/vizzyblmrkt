import { NextResponse } from "next/server";
import { raiseAdmin } from "@/lib/raise/pipeline/admin";
import { decideFollowUp } from "@/lib/raise/pipeline/followups";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Review, Follow-ups from your board (RAISE_FOLLOWUPS_ENABLED): `{ op: "followed_up" | "dismiss", rev }`.
 * I followed up today sets Last touch to today and closes the follow-up in one transaction; Dismiss
 * sets it aside. Admins only. Another brand's follow-up, or an id that isn't one, is not found.
 */
export async function POST(req: Request, { params }: { params: Promise<{ actionId: string }> }) {
  const gate = await raiseAdmin(req, { mutate: true, followUps: true });
  if (!gate.ok) return gate.response;
  const { actionId } = await params;
  const r = await decideFollowUp(gate.ctx, actionId, await req.json().catch(() => null));
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
