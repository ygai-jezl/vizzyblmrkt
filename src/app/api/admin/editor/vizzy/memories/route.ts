import { NextResponse } from "next/server";
import { forgetAllEditMemories, listEditMemories } from "@/lib/agents/memoryBank";
import { isBrandVoiceEnabled } from "@/lib/content/brandKit";
import { guardLearningRoute, isLearningOff } from "@/lib/content/editor/vizzyLearningAccess";
import { memoryListLogEntry, writeLearnLog } from "@/lib/loops/learnLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What Vizzy remembers about how the signed-in person edits in this brand (GET), and forgetting
 * all of it (DELETE). Only ever the person's own: the scope comes from the session. A list Memory
 * Bank fails writes one memory_list_failed line with its code (src/lib/loops/learnLog.ts); a
 * failed membership read answers 502 too, with no such line.
 */
export async function GET(req: Request) {
  const g = await guardLearningRoute(req);
  if ("response" in g) return g.response;
  try {
    const [memories, off] = await Promise.all([
      // Only the bank's own failure is logged: Edit mode then closes with only a count (error
      // not_loaded), and this says what the bank answered. The membership read failing is not it.
      listEditMemories(g.ctx).catch((err: unknown) => {
        writeLearnLog(memoryListLogEntry(g.ctx, err));
        throw err;
      }),
      isLearningOff(g.ctx),
    ]);
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
