import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ActionSchema = z.object({
  action: z.enum(["offboard", "delete"]),
  ids: z.array(z.string().min(1)).min(1).max(500),
});

/**
 * Bulk signup lifecycle actions for the admin dashboard. Authenticated via the
 * admin session cookie (NOT host origin); every mutation goes through the
 * tenant-scoped repository, so an admin can only ever touch their own tenant's
 * signups (forTenant verifies ownership before update/delete).
 */
export async function POST(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;

  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = ActionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  const { action, ids } = parsed.data;
  const repo = forTenant(ctx).signups;
  const now = new Date().toISOString();

  let updated = 0;
  const failed: string[] = [];
  for (const id of ids) {
    try {
      if (action === "offboard") {
        // TODO(email): trigger the offboarding email pipeline once email ships.
        await repo.update(id, { status: "offboarded", removedDate: now });
      } else {
        await repo.delete(id);
      }
      updated += 1;
    } catch {
      // Cross-tenant / missing ids are refused by the repository — record, skip.
      failed.push(id);
    }
  }

  return NextResponse.json({ ok: true, action, updated, failed });
}
