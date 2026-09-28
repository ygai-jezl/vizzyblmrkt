import { NextResponse } from "next/server";
import { z } from "zod";
import { clearTenantEmailStyleSuggestion } from "@/lib/tenant/control";
import { emailStyleAdmin } from "@/lib/email/emailStyleAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DismissSchema = z.object({ suggestedAt: z.string().min(1).max(40) });

/**
 * Dismiss Vizzy's Email style suggestion (Brand › Email style). Admin-only. Clears it only if
 * it's still the one the admin saw (its `suggestedAt`), so a newer suggestion survives; the
 * saved style is never touched. `cleared: false` means it had already gone or been replaced.
 */
export async function DELETE(req: Request) {
  const g = await emailStyleAdmin(req);
  if (!g.ok) return g.response;

  const parsed = DismissSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  const cleared = await clearTenantEmailStyleSuggestion(g.ctx.tenantId, parsed.data.suggestedAt);
  return NextResponse.json({ ok: true, cleared });
}
