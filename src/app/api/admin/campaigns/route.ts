import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant, TenantIsolationError } from "@/lib/tenant";
import {
  CampaignSettingsSchema,
  CampaignIdSchema,
  slugifyCampaignId,
} from "@/lib/admin/campaignSettings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Create a new launch (campaign). Same auth model as the PUT update route:
 * authenticated via the admin session cookie (NOT host origin), and the write
 * goes through the tenant-scoped repository so the campaign is always stamped
 * with the admin's own tenant. The id is the public `/waitlist/<id>` slug —
 * taken from the caller or derived from the name — and `create()` atomically
 * rejects a collision (surfaced as 409).
 *
 * Body: `{ id?: string, settings: CampaignSettings }`.
 */
export async function POST(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;

  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { id?: unknown; settings?: unknown }
    | null;

  const settings = CampaignSettingsSchema.safeParse(body?.settings);
  if (!settings.success) {
    return NextResponse.json(
      {
        error: "invalid_input",
        issues: settings.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }

  const provided = typeof body?.id === "string" ? body.id : "";
  const rawId = (provided.trim() || slugifyCampaignId(settings.data.waitlistName)).toLowerCase();
  const id = CampaignIdSchema.safeParse(rawId);
  if (!id.success) {
    return NextResponse.json(
      { error: "invalid_id", message: id.error.issues[0]?.message ?? "invalid id" },
      { status: 400 },
    );
  }

  try {
    await forTenant(ctx).campaigns.create(id.data, {
      ...settings.data,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    // Atomic create() rejects an id that already exists in ANY tenant.
    if (err instanceof TenantIsolationError) {
      return NextResponse.json(
        { error: "id_taken", message: `A launch with id "${id.data}" already exists.` },
        { status: 409 },
      );
    }
    throw err;
  }

  return NextResponse.json({ ok: true, id: id.data }, { status: 201 });
}
