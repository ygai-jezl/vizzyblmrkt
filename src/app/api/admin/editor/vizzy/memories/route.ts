import { NextResponse } from "next/server";
import { forgetAllEditMemories, listEditMemories } from "@/lib/agents/memoryBank";
import { isBrandVoiceEnabled } from "@/lib/content/brandKit";
import { guardLearningRoute, isLearningOff } from "@/lib/content/editor/vizzyLearningAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What Vizzy remembers about how the signed-in person edits in this brand (GET), and forgetting
 * all of it (DELETE). Only ever the person's own: the scope comes from the session.
 */
export async function GET(req: Request) {
  const g = await guardLearningRoute(req);
  if ("response" in g) return g.response;
  try {
    const [memories, off] = await Promise.all([listEditMemories(g.ctx), isLearningOff(g.ctx)]);
    return NextResponse.json({
      learn: !off,
      memories,
      canAddToBrandVoice: g.ctx.role === "admin" && isBrandVoiceEnabled(),
    });
  } catch (err) {
    console.warn("[edit-vizzy] memories failed:", err instanceof Error ? err.message.slice(0, 200) : "error");
    return NextResponse.json({ error: "memory_unavailable" }, { status: 502 });
  }
}

export async function DELETE(req: Request) {
  const g = await guardLearningRoute(req);
  if ("response" in g) return g.response;
  try {
    return NextResponse.json({ forgotten: await forgetAllEditMemories(g.ctx) });
  } catch (err) {
    console.warn("[edit-vizzy] forget all failed:", err instanceof Error ? err.message.slice(0, 200) : "error");
    return NextResponse.json({ error: "memory_unavailable" }, { status: 502 });
  }
}
