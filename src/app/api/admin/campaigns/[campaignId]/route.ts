import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant, deleteLaunch, TenantIsolationError } from "@/lib/tenant";
import { CampaignSettingsSchema } from "@/lib/admin/campaignSettings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Update a campaign's editable settings. Authenticated via the admin session
 * cookie (NOT host origin); the update goes through the tenant-scoped
 * repository, so an admin can only ever modify their own tenant's campaign
 * (forTenant verifies ownership before the write). The strict schema rejects
 * any attempt to change identity/immutable fields (tenantId/id/createdAt).
 */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;

  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { campaignId } = await params;

  const parsed = CampaignSettingsSchema.safeParse(
    await req.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_input",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }

  try {
    await forTenant(ctx).campaigns.update(campaignId, parsed.data);
  } catch (err) {
    // The repository refuses cross-tenant / missing ids — surface as 404 rather
    // than leaking whether the id exists in another tenant.
    if (err instanceof TenantIsolationError) {
      return NextResponse.json({ error: "campaign_not_found" }, { status: 404 });
    }
    throw err;
  }

  // Echo the SERVER-NORMALISED settings (questions collapsed, fields trimmed) so
  // the editor can re-seed its state to exactly what was persisted.
  return NextResponse.json({ ok: true, settings: parsed.data });
}

/**
 * Permanently delete a launch and purge all of its data (campaign config,
 * signups, broadcasts, journeys, queued email jobs), leaving only an immutable,
 * PII-free audit record. Irreversible.
 *
 * Defence in depth:
 *  - same-origin guard + admin session cookie (authn);
 *  - ADMIN role required — a `member` is refused (separation of duties, SOC 2
 *    CC6.x). The role comes from the verified token, never the request;
 *  - an explicit `confirm` field that must echo the launch id, so a stray/replayed
 *    request cannot destroy a launch without intent;
 *  - the purge itself runs through the tenant-scoped repository, so it can only
 *    ever touch the admin's own tenant.
 *
 * Body: `{ confirm: "<campaignId>", reason?: string }`.
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;

  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // The role is read from the verified session-cookie claims (getAdminContext →
  // verifySessionCookie with checkRevoked=true), so a disabled/revoked user is
  // already rejected. The one residual gap — shared with EVERY admin mutation in
  // this claims-based layer — is a role DOWNGRADE that hasn't yet propagated to a
  // refreshed token; the correct fix is to revoke sessions on role change (in the
  // membership-management flow), NOT a per-request tenant_users lookup here (the
  // home tenant deliberately has no membership row, so that would 403 every
  // legitimate home admin).
  if (ctx.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { campaignId } = await params;

  const body = (await req.json().catch(() => null)) as
    | { confirm?: unknown; reason?: unknown }
    | null;
  // Typed-confirmation: the caller must echo the exact launch id. Guards against
  // accidental/replayed deletes; the UI makes the operator type it to enable.
  if (!body || body.confirm !== campaignId) {
    return NextResponse.json(
      { error: "confirmation_required" },
      { status: 400 },
    );
  }
  const reason =
    typeof body.reason === "string" && body.reason.trim()
      ? body.reason.trim().slice(0, 2000)
      : undefined;

  try {
    const { deleted, auditComplete } = await deleteLaunch(ctx, campaignId, { reason });
    if (!auditComplete) {
      // The launch was purged but the authoritative WORM outcome record could not
      // be persisted (the durable "initiated" record still exists). Don't hide it
      // behind a clean 200 — flag it so the operator/monitoring can reconcile.
      console.error(
        `[audit] launch ${campaignId} (tenant ${ctx.tenantId}) purged but WORM outcome record FAILED — needs reconciliation`,
      );
    }
    return NextResponse.json({ ok: true, deleted, auditComplete });
  } catch (err) {
    // Unknown / cross-tenant id — surface as 404 rather than leaking existence
    // in another tenant. (A partial-failure mid-purge still recorded a "failed"
    // audit row inside deleteLaunch before re-throwing here.)
    if (err instanceof TenantIsolationError) {
      return NextResponse.json({ error: "campaign_not_found" }, { status: 404 });
    }
    throw err;
  }
}
