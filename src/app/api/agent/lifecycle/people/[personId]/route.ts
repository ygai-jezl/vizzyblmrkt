import { NextResponse } from "next/server";
import { isRateLimited } from "@/lib/tenant";
import { isPersonBriefEnabled } from "@/lib/audience/flags";
import { loadPersonBrief } from "@/lib/audience/personBrief";
import { agentGate } from "@/lib/lifecycle/agentApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Vizzy reads a person a few times in a conversation, not hundreds. */
const BRIEF_LIMIT = { prefix: "person_brief", burstLimit: 20, hourlyLimit: 200 };

/**
 * For Vizzy's lifecycle_ops agent (LIFECYCLE_PERSON_BRIEF): ONE person's situation
 * — stage, journeys, emails — with no name, no address and none of the product's
 * ids (src/lib/audience/personBrief.ts). Auth: the signed canvas capability token
 * in `X-Canvas-Context`, so only for the brand the operator is signed in to.
 */
export async function GET(req: Request, { params }: { params: Promise<{ personId: string }> }) {
  const gate = agentGate(req);
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status });
  if (!isPersonBriefEnabled()) return NextResponse.json({ error: "person_brief_unavailable" }, { status: 503 });
  if (await isRateLimited(`tenant:${gate.ctx.tenantId}`, BRIEF_LIMIT)) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const { personId } = await params;
  const r = await loadPersonBrief(gate.ctx, personId);
  // Who asked about whom, by id only: a person's data left for the model.
  console.info(`[person-brief] tenant=${gate.ctx.tenantId} operator=${gate.ctx.userId ?? "unknown"} person=${personId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80)} found=${r.found}`);
  if (!r.found) return NextResponse.json({ error: r.erased ? "person_erased" : "person_not_found" }, { status: 404 });
  return NextResponse.json({ brief: r.brief }, { headers: { "cache-control": "no-store" } });
}
