import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant, TenantIsolationError } from "@/lib/tenant";
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
