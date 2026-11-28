import { NextResponse } from "next/server";
import { z } from "zod";
import { isRateLimited } from "@/lib/tenant";
import { pasteAdmin } from "@/lib/crm/paste/admin";
import { addPasteBatch } from "@/lib/crm/paste/apply";
import { dismissPasteBatch, readPasteBatch } from "@/lib/crm/paste/batch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };
const APPLY_LIMIT = { prefix: "paste_apply", burstLimit: 10, hourlyLimit: 60 };

const Body = z.object({ action: z.enum(["add", "dismiss"]), rev: z.number().int().min(1) }).strict();

/**
 * One pasted list waiting in Review (RAISE_PASTE_ENABLED), admins only. GET: what it adds, for the
 * sheet to open on it from Review or Vizzy's card, while it is open and under 7 days old; 404
 * `paste_gone` otherwise (another brand's id reads as not found). POST `{ action: "add", rev }`
 * adds everyone on it and closes it; `{ action: "dismiss", rev }` declines it and clears its rows.
 * 409 `changed` when someone moved it since `rev`.
 */
export async function GET(req: Request, { params }: { params: Promise<{ batchId: string }> }) {
  const gate = await pasteAdmin(req);
  if (!gate.ok) return gate.response;
  const { batchId } = await params;
  const r = await readPasteBatch(gate.ctx, batchId);
  if (!r) return NextResponse.json({ error: "paste_gone" }, { status: 404, headers: noStore });
  return NextResponse.json(r, { headers: noStore });
}

export async function POST(req: Request, { params }: { params: Promise<{ batchId: string }> }) {
  const gate = await pasteAdmin(req);
  if (!gate.ok) return gate.response;
  const ctx = gate.ctx;
  if (await isRateLimited(`user:${ctx.tenantId}:${ctx.userId}`, APPLY_LIMIT)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: noStore });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400, headers: noStore });
  const { batchId } = await params;
  const { action, rev } = parsed.data;

  if (action === "dismiss") {
    const d = await dismissPasteBatch(ctx, batchId, rev);
    if (d === "changed") return NextResponse.json({ error: "changed" }, { status: 409, headers: noStore });
    if (d === "paste_gone") return NextResponse.json({ error: "paste_gone" }, { status: 404, headers: noStore });
    return NextResponse.json({ dismissed: true }, { headers: noStore });
  }

  try {
    const r = await addPasteBatch(ctx, batchId, rev);
    if (!r.ok) {
      if (r.error === "changed") return NextResponse.json({ error: "changed" }, { status: 409, headers: noStore });
      if (r.error === "no_user") return NextResponse.json({ error: "forbidden" }, { status: 403, headers: noStore });
      return NextResponse.json({ error: "paste_gone" }, { status: 404, headers: noStore });
    }
    return NextResponse.json({ added: r.added, already: r.already, fieldsNotSaved: r.fieldsNotSaved }, { headers: noStore });
  } catch (err) {
    // Counts and a code only. A press again picks up where this stopped: every add is idempotent.
    console.error(`[paste] add failed tenant=${ctx.tenantId} code=${err instanceof Error ? err.name : "error"}`);
    return NextResponse.json({ error: "failed" }, { status: 500, headers: noStore });
  }
}
