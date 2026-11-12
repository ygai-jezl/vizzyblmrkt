import { NextResponse } from "next/server";
import { getEditMemory } from "@/lib/agents/memoryBank";
import { isBrandVoiceEnabled } from "@/lib/content/brandKit";
import { guardLearningRoute } from "@/lib/content/editor/vizzyLearningAccess";
import { appendBrandVoiceRule } from "@/lib/tenant/control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ memoryId: string }> };

/**
 * Turn one of the admin's own editing memories into a rule in the brand voice, for the whole team
 * (Brand kit, "Do"). Admins only; the memory must be theirs.
 */
export async function POST(req: Request, { params }: RouteParams) {
  const g = await guardLearningRoute(req);
  if ("response" in g) return g.response;
  if (g.ctx.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!isBrandVoiceEnabled()) return NextResponse.json({ error: "brand_voice_disabled" }, { status: 503 });
  const { memoryId } = await params;
  try {
    const memory = await getEditMemory(g.ctx, memoryId);
    if (!memory) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const result = await appendBrandVoiceRule(g.ctx.tenantId, memory.text);
    if (result === "full") return NextResponse.json({ error: "brand_voice_full" }, { status: 409 });
    if (result === "missing") return NextResponse.json({ error: "brand_voice_unavailable" }, { status: 409 });
    return NextResponse.json({ added: result === "added" });
  } catch (err) {
    console.warn("[edit-vizzy] add to brand voice failed:", err instanceof Error ? err.message.slice(0, 200) : "error");
    return NextResponse.json({ error: "memory_unavailable" }, { status: 502 });
  }
}
