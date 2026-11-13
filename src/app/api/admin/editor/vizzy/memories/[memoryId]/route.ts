import { NextResponse } from "next/server";
import { forgetEditMemory } from "@/lib/agents/memoryBank";
import { guardLearningRoute } from "@/lib/content/editor/vizzyLearningAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ memoryId: string }> };

/** Forget one memory. Another person's (or brand's) memory reads as not found. */
export async function DELETE(req: Request, { params }: RouteParams) {
  const g = await guardLearningRoute(req);
  if ("response" in g) return g.response;
  const { memoryId } = await params;
  try {
    if (!(await forgetEditMemory(g.ctx, memoryId))) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.warn("[edit-vizzy] forget failed:", err instanceof Error ? err.message.slice(0, 200) : "error");
    return NextResponse.json({ error: "memory_unavailable" }, { status: 502 });
  }
}
