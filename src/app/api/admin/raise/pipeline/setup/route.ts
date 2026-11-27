import { NextResponse } from "next/server";
import { raiseAdmin } from "@/lib/raise/pipeline/admin";
import { setupPreviewRequest, setupRequest } from "@/lib/raise/pipeline/setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Settings › Data model, Ready-made fields (RAISE_PIPELINE_ENABLED). Admins only.
 * GET `?kit=raising|funding&currency=GBP`: what a press would add, use and keep, and which kit to show
 * first. POST `{ kit, currency? }`: the press, as one settings version; a second press adds nothing.
 */
export async function GET(req: Request) {
  const gate = await raiseAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  // Each query value once, as given (a repeated key keeps its last value).
  const query = Object.fromEntries(new URL(req.url).searchParams.entries());
  const r = await setupPreviewRequest(gate.ctx, query);
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const gate = await raiseAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  const r = await setupRequest(gate.ctx, await req.json().catch(() => null));
  return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
