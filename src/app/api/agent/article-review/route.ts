import { NextResponse } from "next/server";
import { agentReadReview, agentReviewArticle, reviewAgentGate } from "@/lib/content/blog/refreshAgentApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * For Vizzy's review_article (BLOG_REFRESH_CHAT_ENABLED): GET `?articleId=` says where an article's
 * refresh review is and what it proposes; POST `{ articleId }` starts one, or moves the running one
 * a step. Never applies a change: a person does, on the article.
 */
export async function GET(req: Request) {
  const gate = await reviewAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const r = await agentReadReview(gate.ctx, new URL(req.url).searchParams.get("articleId") ?? "");
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const gate = await reviewAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const r = await agentReviewArticle(gate.ctx, await req.json().catch(() => null));
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
