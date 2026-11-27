import { NextResponse } from "next/server";
import { z } from "zod";
import { clearTenantEmailStyleSuggestion } from "@/lib/tenant/control";
import { emailStyleAdmin } from "@/lib/email/emailStyleAdmin";
import { closeStyle, memberOf } from "@/lib/agentRecord/record";
import { forgetReviewCount } from "@/lib/review/summary";

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
  // Dismissed by this admin (agent record); a newer suggestion already closed it as superseded.
  await closeStyle(g.ctx, "email_style.suggest", parsed.data.suggestedAt, { to: "declined", reason: "dismissed", by: memberOf(g.ctx) });
  forgetReviewCount(g.ctx.tenantId);
  return NextResponse.json({ ok: true, cleared });
}
