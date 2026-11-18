import { NextResponse } from "next/server";
import { z } from "zod";
import { agentContextPack, contextAgentGate } from "@/lib/brandContext/agentApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Id = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
const Query = z.object({
  question: Id.optional(),
  subject: Id.optional(),
  text: z.string().trim().min(3).max(300).optional(),
});

/**
 * For Vizzy's get_brand_context: what the brand knows about one question (by brand map id, or in
 * words) or one subject: the brand map, what it already made, what competitors wrote, and what
 * Google shows, each number with its meaning. Gated by BRAND_CONTEXT_ENABLED.
 */
export async function GET(req: Request) {
  const gate = await contextAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const url = new URL(req.url);
  const parsed = Query.safeParse({
    question: url.searchParams.get("question") ?? undefined,
    subject: url.searchParams.get("subject") ?? undefined,
    text: url.searchParams.get("text") ?? undefined,
  });
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const r = await agentContextPack(gate.ctx, { questionId: parsed.data.question ?? null, subjectId: parsed.data.subject ?? null, text: parsed.data.text ?? null });
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
