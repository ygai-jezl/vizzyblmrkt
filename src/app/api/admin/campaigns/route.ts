import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import {
  CampaignSettingsSchema,
  CampaignIdSchema,
  slugifyCampaignId,
} from "@/lib/admin/campaignSettings";
import { createLaunch, LaunchIdTakenError } from "@/lib/admin/createLaunch";
import { isWaitlistEngineEnabled, isWaitlistEnginePilot, isWaitlistEngineUiEnabled } from "@/lib/lifecycle/waitlist/flags";
import { createWaitlistJourney } from "@/lib/lifecycle/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Create a new launch (campaign). Same auth model as the PUT update route:
 * authenticated via the admin session cookie (NOT host origin), and the write
 * goes through the tenant-scoped repository so the campaign is always stamped
 * with the admin's own tenant. The id is the public `/waitlist/<id>` slug —
 * taken from the caller or derived from the name. A DERIVED slug that collides
 * is auto-suffixed (`-2`, `-3`, …) so a brand never blocks another's launch
 * name; an EXPLICIT slug that collides is reported as 409 (see createLaunch).
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
  const explicit = provided.trim().length > 0;
  const rawId = (provided.trim() || slugifyCampaignId(settings.data.waitlistName)).toLowerCase();
  const id = CampaignIdSchema.safeParse(rawId);
  if (!id.success) {
    return NextResponse.json(
      { error: "invalid_id", message: id.error.issues[0]?.message ?? "invalid id" },
      { status: 400 },
    );
  }

  // Engine move (pilot): a pilot tenant's new launch starts on the lifecycle
  // engine, with a draft welcome journey there. Its first publish enrols everyone.
  const now = new Date().toISOString();
  const onLifecycle = isWaitlistEngineEnabled() && isWaitlistEngineUiEnabled() && isWaitlistEnginePilot(ctx.tenantId);
  try {
    const createdId = await createLaunch(
      forTenant(ctx).campaigns,
      id.data,
      {
        ...settings.data,
        createdAt: now,
        ...(onLifecycle
          ? {
              waitlistEngine: "lifecycle" as const,
              waitlistEngineSince: now,
              waitlistEngineHistory: [{ engine: "lifecycle" as const, at: now, by: ctx.email ?? ctx.userId ?? null }],
            }
          : {}),
      },
      { explicit },
    );
    if (onLifecycle) {
      const created = await createWaitlistJourney(ctx, { campaignId: createdId }).catch(() => null);
      if (!created?.ok) console.warn(`[engine] welcome journey not created for new launch ${createdId}`);
    }
    return NextResponse.json({ ok: true, id: createdId }, { status: 201 });
  } catch (err) {
    // Explicit slug taken (or derived suffixes exhausted) → conflict.
    if (err instanceof LaunchIdTakenError) {
      return NextResponse.json(
        { error: "id_taken", message: err.message },
        { status: 409 },
      );
    }
    throw err;
  }
}
