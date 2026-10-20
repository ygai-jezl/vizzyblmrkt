import { NextResponse } from "next/server";
import { answerFromRequest, notesAdmin } from "@/lib/brandNotes/api";
import { isRateLimited } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ noteId: string }> };

/** Saved as a person types: bounded per person, as an article's answers are. */
const ANSWER_LIMIT = { prefix: "brand_note_answer", burstLimit: 60, hourlyLimit: 900 };

/** Answer an open question, or change or clear its answer, as it is typed (admins). */
export async function PUT(req: Request, { params }: RouteParams) {
  const g = await notesAdmin(req);
  if (!g.ok) return g.response;
  if (await isRateLimited(`user:${g.ctx.tenantId}:${g.ctx.userId ?? "anon"}`, ANSWER_LIMIT)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  const { noteId } = await params;
  return answerFromRequest(g.ctx, noteId, await req.json().catch(() => null));
}
