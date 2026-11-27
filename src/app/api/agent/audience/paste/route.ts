import { NextResponse } from "next/server";
import { z } from "zod";
import { pasteAgentGate, pasteBody } from "@/lib/crm/paste/admin";
import { readPaste } from "@/lib/crm/paste/batch";
import { pasteHref } from "@/lib/crm/paste/review";
import { agentSummary, cardStats, PASTE_CARD, PASTE_MESSAGES, ROW_REASONS, type PasteMessage } from "@/lib/crm/paste/words";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };

const Body = z.object({ text: z.string(), source: z.string().max(200).default("") }).strict();

const refuse = (status: number, error: PasteMessage) => NextResponse.json({ ok: false, error, message: PASTE_MESSAGES[error] }, { status, headers: noStore });

/**
 * For Vizzy's paste_list_propose (RAISE_PASTE_ENABLED with AUDIENCE_VIZZY_ADD_PERSON_ENABLED): the
 * rows the operator pasted into the chat, read by the app's own code into one card waiting in
 * Review for an admin to add. Vizzy never records consent: a body naming any is refused. Auth: the
 * signed canvas token in `X-Canvas-Context`, which names the brand and the member asking; the body
 * never does. The answer never echoes a cell: left out rows come by number and reason only.
 */
export async function POST(req: Request) {
  const gate = await pasteAgentGate(req);
  if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status, headers: noStore });
  const ctx = gate.ctx;
  const read = await pasteBody(req);
  if (!read.ok) return refuse(400, read.error);
  const raw = read.body;
  if (raw && typeof raw === "object" && ("agreed" in raw || "consent" in raw)) return refuse(400, "consent_not_allowed");
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return refuse(400, "invalid_input");

  try {
    const r = await readPaste(ctx, { text: parsed.data.text, source: parsed.data.source, from: "chat" });
    if (!r.ok) return refuse(400, r.error);
    const leftOut = r.skipped.map((s) => ({ row: s.row, reason: s.reason, text: ROW_REASONS[s.reason] }));
    if (r.outcome === "nothing_to_add") return NextResponse.json({ ok: true, status: "nothing_to_add", summary: PASTE_MESSAGES.nothing_to_add, leftOut }, { headers: noStore });
    const { id, counts } = r.batch;
    const url = pasteHref(id);
    const skipped = counts.left + counts.already;
    return NextResponse.json(
      {
        ok: true,
        status: "ready",
        id,
        url,
        summary: agentSummary(counts.read, counts.people, counts.companies, skipped),
        counts,
        leftOut,
        card: {
          kind: "paste_batch",
          id,
          title: PASTE_CARD.title,
          url,
          stats: cardStats({ people: counts.people, companies: counts.companies, skipped }),
          // Rows left out show as a stat: the card can't fix them, and one already here needs nothing.
          warnings: 0,
          note: PASTE_CARD.note,
          cta: PASTE_CARD.cta,
        },
      },
      { headers: noStore },
    );
  } catch (err) {
    console.error(`[paste] read failed tenant=${ctx.tenantId} code=${err instanceof Error ? err.name : "error"}`);
    return refuse(500, "failed");
  }
}
