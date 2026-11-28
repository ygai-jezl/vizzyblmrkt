import { NextResponse } from "next/server";
import { z } from "zod";
import { isRateLimited } from "@/lib/tenant";
import { pasteAdmin, pasteBody } from "@/lib/crm/paste/admin";
import { readPaste } from "@/lib/crm/paste/batch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };
/** A team reading a few lists in a sitting, never a script. */
const READ_LIMIT = { prefix: "paste_read", burstLimit: 10, hourlyLimit: 60 };

const Body = z.object({ text: z.string(), source: z.string().max(200) }).strict();

/**
 * Paste a list (RAISE_PASTE_ENABLED), admins only: read pasted rows into one card waiting in
 * Review. 201 `{ batch, skipped, warning }`; 200 `{ batch: null, skipped, error: "nothing_to_add" }`
 * when every row is left out or already here (nothing saved). `skipped` gives row numbers and
 * reasons only, never a cell. The brand is the session's: a tenantId in the body is refused.
 */
export async function POST(req: Request) {
  const gate = await pasteAdmin(req);
  if (!gate.ok) return gate.response;
  const ctx = gate.ctx;
  if (await isRateLimited(`user:${ctx.tenantId}:${ctx.userId}`, READ_LIMIT)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: noStore });
  }
  const read = await pasteBody(req);
  if (!read.ok) return NextResponse.json({ error: read.error }, { status: read.error === "too_long" ? 413 : 400, headers: noStore });
  const parsed = Body.safeParse(read.body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400, headers: noStore });
  try {
    const r = await readPaste(ctx, { text: parsed.data.text, source: parsed.data.source, from: "box" });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.error === "too_long" ? 413 : 400, headers: noStore });
    if (r.outcome === "nothing_to_add") return NextResponse.json({ batch: null, skipped: r.skipped, warning: null, error: "nothing_to_add" }, { headers: noStore });
    return NextResponse.json({ batch: r.batch, skipped: r.skipped, warning: r.warning }, { status: 201, headers: noStore });
  } catch (err) {
    // A code only: never the text, a cell or a count of who.
    console.error(`[paste] read failed tenant=${ctx.tenantId} code=${err instanceof Error ? err.name : "error"}`);
    return NextResponse.json({ error: "failed" }, { status: 500, headers: noStore });
  }
}
