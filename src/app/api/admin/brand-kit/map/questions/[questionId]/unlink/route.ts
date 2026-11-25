import { NextResponse } from "next/server";
import { brandMapAdmin } from "@/lib/brandMap/adminApi";
import { isNextUpRepeatsEnabled } from "@/lib/autopilot/flags";
import { unlinkQuestion } from "@/lib/nextUp/repeats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ questionId: string }> };

/**
 * Unlink (NEXT_UP_REPEATS_ENABLED): the article Next up matched a question to by meaning doesn't
 * answer it. The link goes and the page is never matched to it again. Admin-only, as for any edit
 * to a question.
 */
export async function POST(req: Request, { params }: RouteParams) {
  const g = await brandMapAdmin(req, { on: isNextUpRepeatsEnabled, offError: "unavailable" });
  if (!g.ok) return g.response;
  const { questionId } = await params;
  if (!/^q_[A-Za-z0-9]{6,40}$/.test(questionId)) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  return (await unlinkQuestion(g.ctx, questionId))
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "not_linked" }, { status: 404 });
}
