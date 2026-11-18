import { NextResponse } from "next/server";
import { z } from "zod";
import { resultsAgentGate } from "@/lib/metrics/agentGate";
import { postResults } from "@/lib/metrics/results";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Query = z.object({
  channel: z.enum(["linkedin", "x"]).optional(),
  days: z.coerce.number().int().min(1).max(365).default(30),
  post: z.string().trim().min(1).max(200).optional(),
});

/**
 * For Vizzy's get_post_results: how the brand's LinkedIn and X posts did over a period, or one
 * post, with the meaning of every number. Gated by RESULTS_CHAT_ENABLED.
 */
export async function GET(req: Request) {
  const gate = await resultsAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const url = new URL(req.url);
  const parsed = Query.safeParse({
    channel: url.searchParams.get("channel") ?? undefined,
    days: url.searchParams.get("days") ?? undefined,
    post: url.searchParams.get("post") ?? undefined,
  });
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const r = await postResults(gate.ctx, parsed.data);
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
