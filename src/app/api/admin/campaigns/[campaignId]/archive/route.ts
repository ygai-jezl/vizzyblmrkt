import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { setLaunchArchived, TenantIsolationError } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ActionSchema = z.object({
  action: z.enum(["archive", "restore"]),
  reason: z.string().trim().max(2000).optional(),
});

/**
 * Archive (close) or restore (reopen) a launch — the non-destructive, reversible
 * counterpart to DELETE. Archiving stops public signups, pauses the active
 * journey, and hides the launch from the active list, while PRESERVING all data.
 *
 * Defence in depth (mirrors the DELETE handler):
 *  - same-origin guard + admin session cookie (authn);
 *  - ADMIN role required — a `member` is refused (separation of duties). The role
 *    comes from the verified token, never the request;
 *  - the mutation runs through the tenant-scoped repository, so it can only ever
 *    touch the admin's own tenant.
 *
 * Unlike DELETE there is NO typed-confirmation: archiving is reversible, so an
 * admin-role check + same-origin guard are sufficient. An optional `reason` is
 * recorded on the (best-effort) audit trail.
 *
 * Body: `{ action: "archive" | "restore", reason?: string }`.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;

  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (ctx.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { campaignId } = await params;
  const parsed = ActionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }

  try {
    const result = await setLaunchArchived(ctx, campaignId, parsed.data.action, {
      reason: parsed.data.reason,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    // Unknown / cross-tenant id — surface as 404 rather than leaking existence
    // in another tenant.
    if (err instanceof TenantIsolationError) {
      return NextResponse.json({ error: "campaign_not_found" }, { status: 404 });
    }
    throw err;
  }
}
