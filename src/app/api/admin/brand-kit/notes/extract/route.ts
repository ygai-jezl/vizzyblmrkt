import { NextResponse } from "next/server";
import { handBack, withStampToken } from "@/lib/loops/handBack";
import { learnedFor } from "@/lib/loops/read";
import { z } from "zod";
import { getTenantById, isRateLimited } from "@/lib/tenant";
import { notesAdmin } from "@/lib/brandNotes/api";
import { extractNotes, MAX_PASTE } from "@/lib/brandNotes/extract";
import { aiUsage } from "@/lib/plans/meter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Each run sends up to 30,000 characters to the model: bounded per tenant. */
const EXTRACT_LIMIT = { prefix: "brand_notes_extract", burstLimit: 3, hourlyLimit: 20 };
const Body = z.object({ text: z.string().trim().min(40).max(MAX_PASTE) });

/**
 * Brand › What we've seen › Paste a call or document (admins): the notes found in the pasted
 * text, for a person to tick. The text is read by the model and never stored; nothing is kept
 * until the notes a person ticks are added.
 */
export async function POST(req: Request) {
  const g = await notesAdmin(req);
  if (!g.ok) return g.response;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  if (await isRateLimited(`tenant:${g.ctx.tenantId}`, EXTRACT_LIMIT)) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const tenant = await getTenantById(g.ctx.tenantId).catch(() => null);
  const found = await extractNotes(parsed.data.text, tenant?.tenantName?.trim() ?? "", aiUsage(g.ctx, "brand_notes", { tenant }));
  if (found === null) return NextResponse.json({ error: "extract_failed" }, { status: 502 });
  // Handed to the browser to save later: counted made once and its stamp signed for the save (learning loops step 5, decision 20).
  const stampToken = await handBack(g.ctx, "brand_notes", (await learnedFor(g.ctx, "brand_notes")).stamp);
  return NextResponse.json(withStampToken({ found }, stampToken));
}
