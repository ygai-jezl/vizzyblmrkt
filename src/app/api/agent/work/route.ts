import { NextResponse } from "next/server";
import { readRequestTextCapped } from "@/lib/http/readBody";
import { agentGetWork, agentWorkPost, queryOf, workAgentGate } from "@/lib/work/agentApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The most a Vizzy Work call's body may be: a suggestion's longest text and links fit well inside it. */
const BODY_MAX_BYTES = 64_000;

const NO_STORE = { "cache-control": "no-store" };

/**
 * For Vizzy's Work tools (WORK_VIZZY_ENABLED, which needs WORK_ENABLED). GET is get_work: the list
 * or one task (`?ref=73`), the Log day (`?day=YYYY-MM-DD`), and the suggestions waiting and
 * dismissed. POST runs suggest_work_task, draft_work_log or draft_work_decision, named by `tool`:
 * each a suggestion or a draft a person adds, saves or decides in the app. Auth: the signed
 * canvas capability token in `X-Canvas-Context`; the brand and the person come from it, never
 * from the query or the body.
 */
export async function GET(req: Request) {
  const gate = await workAgentGate(req, "read");
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status, headers: NO_STORE });
  const r = await agentGetWork(gate.ctx, queryOf(new URL(req.url).searchParams));
  return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
}

export async function POST(req: Request) {
  const gate = await workAgentGate(req, "write");
  if (!gate.ok) return NextResponse.json(gate.result.body, { status: gate.result.status, headers: NO_STORE });
  const text = await readRequestTextCapped(req, BODY_MAX_BYTES);
  if (text === null) return NextResponse.json({ error: "too_large" }, { status: 413, headers: NO_STORE });
  let body: unknown = null;
  try {
    body = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    body = null;
  }
  const r = await agentWorkPost(gate.ctx, body);
  return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
}
