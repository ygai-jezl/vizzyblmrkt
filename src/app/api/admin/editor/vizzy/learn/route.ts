import { NextResponse } from "next/server";
import { learnFromEdits } from "@/lib/agents/memoryBank";
import { readRequestTextCapped } from "@/lib/http/readBody";
import { isRateLimited } from "@/lib/tenant";
import type { RateLimitConfig } from "@/lib/tenant/rateLimit";
import { LearnRequestSchema } from "@/lib/content/editor/vizzyLearning";
import { guardLearningRoute, isLearningOff } from "@/lib/content/editor/vizzyLearningAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Per person: one call when Edit mode closes, so a few a minute is plenty. */
const LIMIT: RateLimitConfig = { prefix: "edit_vizzy_learn", burstLimit: 6, hourlyLimit: 60 };

/**
 * What the person kept and undid in one Edit mode visit, for Memory Bank to learn from. Only the
 * changed words are sent (see vizzyLearning.ts). Nothing is sent when they've switched learning
 * off. Memory Bank does the work in the background.
 */
export async function POST(req: Request) {
  const g = await guardLearningRoute(req);
  if ("response" in g) return g.response;
  const raw = await readRequestTextCapped(req, 64_000);
  let json: unknown = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }
  const parsed = LearnRequestSchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  if (await isLearningOff(g.ctx)) return NextResponse.json({ learned: false, reason: "learning_off" });
  if (await isRateLimited(`user:${g.ctx.tenantId}:${g.ctx.userId}`, LIMIT)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  try {
    await learnFromEdits(g.ctx, parsed.data.entries);
    return NextResponse.json({ learned: true }, { status: 202 });
  } catch (err) {
    console.warn("[edit-vizzy] learn failed:", err instanceof Error ? err.message.slice(0, 200) : "error");
    return NextResponse.json({ error: "memory_unavailable" }, { status: 502 });
  }
}
