import { NextResponse } from "next/server";
import { vizzyAddPersonAdmin } from "@/lib/audience/admin";
import { dismissNewPersonDraft, readNewPersonDraft } from "@/lib/audience/personDrafts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };

/**
 * A New person form Vizzy filled in (AUDIENCE_VIZZY_ADD_PERSON_ENABLED), admins only. GET: what it
 * holds, for the form to open filled in, while it is open and under 7 days old; 404 `draft_gone`
 * otherwise. DELETE: dismiss it, clearing what was typed. Adding them goes through the New person
 * route with the draft's id, which closes it.
 */
export async function GET(req: Request, { params }: { params: Promise<{ draftId: string }> }) {
  const gate = await vizzyAddPersonAdmin(req);
  if (!gate.ok) return gate.response;
  const { draftId } = await params;
  const draft = await readNewPersonDraft(gate.ctx, draftId);
  if (!draft) return NextResponse.json({ error: "draft_gone" }, { status: 404, headers: noStore });
  return NextResponse.json({ draft }, { headers: noStore });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ draftId: string }> }) {
  const gate = await vizzyAddPersonAdmin(req);
  if (!gate.ok) return gate.response;
  const { draftId } = await params;
  if (!(await dismissNewPersonDraft(gate.ctx, draftId))) return NextResponse.json({ error: "draft_gone" }, { status: 404, headers: noStore });
  return NextResponse.json({ dismissed: true }, { headers: noStore });
}
