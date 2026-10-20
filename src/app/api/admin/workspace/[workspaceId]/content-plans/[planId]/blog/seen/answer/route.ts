import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant, isRateLimited } from "@/lib/tenant";
import { getContentPlan } from "@/lib/tenant/workspaceContent";
import { isSeenQuestionsOn } from "@/lib/content/blog/hubActions";
import { answerForArticle } from "@/lib/content/blog/seenAnswers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ workspaceId: string; planId: string }> };

/** Saved as a person types (a second after they stop, and when they leave the box): bounded per person. */
const ANSWER_LIMIT = { prefix: "blog_seen_answer", burstLimit: 60, hourlyLimit: 900 };

/**
 * Save an answer to one of a blog article's questions for its team (What we've seen). It writes
 * that question's note only, never the plan, so it can't clash with the canvas's own save.
 * Gated by BRAND_NOTES_QUESTIONS_ENABLED with the notes and the editorial writer (503 otherwise).
 */
export async function PUT(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  if (!isSeenQuestionsOn()) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspaceId, planId } = await params;
  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const plan = await getContentPlan(ctx, workspaceId, planId);
  if (!plan) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (await isRateLimited(`user:${ctx.tenantId}:${ctx.userId ?? "anon"}`, ANSWER_LIMIT)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const r = await answerForArticle(ctx, {
    article: `${workspaceId}/${planId}`,
    subjectId: plan.blog?.subjectId ?? null,
    body: await req.json().catch(() => null),
  });
  return NextResponse.json(r.body, { status: r.status });
}
