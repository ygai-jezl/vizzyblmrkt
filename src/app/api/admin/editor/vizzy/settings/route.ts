import { NextResponse } from "next/server";
import { z } from "zod";
import { guardLearningRoute, setLearningOff } from "@/lib/content/editor/vizzyLearningAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ learn: z.boolean() });

/** The person's "Learn from my edits" choice in this brand. Off: Vizzy neither learns from nor
 *  uses their memories (they stay until forgotten). */
export async function PUT(req: Request) {
  const g = await guardLearningRoute(req);
  if ("response" in g) return g.response;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  if (!(await setLearningOff(g.ctx, !parsed.data.learn))) {
    return NextResponse.json({ error: "member_not_found" }, { status: 404 });
  }
  return NextResponse.json({ learn: parsed.data.learn });
}
