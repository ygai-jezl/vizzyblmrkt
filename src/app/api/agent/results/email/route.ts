import { NextResponse } from "next/server";
import { z } from "zod";
import { resultsAgentGate } from "@/lib/metrics/agentGate";
import { emailResults } from "@/lib/metrics/results";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Query = z.object({
  scope: z.enum(["overview", "launch", "journey"]).default("overview"),
  id: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_:.-]+$/).optional(),
});

/**
 * For Vizzy's get_email_results: how the brand's emails did, overall, for one launch or for one
 * journey, with the meaning of every number. Aggregates only. Gated by RESULTS_CHAT_ENABLED.
 */
export async function GET(req: Request) {
  const gate = await resultsAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  const url = new URL(req.url);
  const parsed = Query.safeParse({ scope: url.searchParams.get("scope") ?? undefined, id: url.searchParams.get("id") ?? undefined });
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const r = await emailResults(gate.ctx, parsed.data);
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
