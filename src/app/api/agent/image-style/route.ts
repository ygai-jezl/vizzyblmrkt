import { NextResponse } from "next/server";
import { agentImageStyle, imageStyleAgentGate } from "@/lib/content/imageStyle/agentApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * For Vizzy: the brand's image style (saved, pending suggestion and the styles to pick from),
 * so it can answer "what's my image style?" and suggest one. No person's data. Auth: the signed
 * canvas capability token in `X-Canvas-Context`; gated by BRAND_IMAGE_STYLE_ENABLED.
 */
export async function GET(req: Request) {
  const gate = imageStyleAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const r = await agentImageStyle(gate.ctx);
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
