import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { removeSignupFromAudience } from "@/lib/mailchimp";
import { recordSignupContactStatus } from "@/lib/crm/contactService";
import { enqueueEmailJob } from "@/lib/email/jobs";
import { effectiveReferralWeight } from "@/lib/waitlist/scoring";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Signup lifecycle + queue actions for the admin dashboard. Authenticated via the
 * admin session cookie (NOT host origin); every mutation goes through the
 * tenant-scoped repository, so an admin can only ever touch their own tenant's
 * signups (forTenant verifies ownership before update/delete).
 *
 *  - offboard / delete: bulk (up to 500). Offboarding KEEPS the person reachable
 *    (it does NOT remove them from the external marketing sync — only delete does)
 *    and reflects the change onto their Unified-CRM contact, then enqueues the
 *    per-campaign offboarding email. Delete is the operational purge.
 *  - move_to_top / move_up: a single, per-campaign queue boost (admin VIP bump).
 *    Improves position only; never moves anyone down (monotonic `manualBoost`).
 */
const ActionSchema = z.object({
  action: z.enum(["offboard", "delete", "move_to_top", "move_up"]),
  // Bulk lifecycle actions:
  ids: z.array(z.string().min(1)).min(1).max(500).optional(),
  // Single move actions:
  id: z.string().min(1).optional(),
  campaignId: z.string().min(1).optional(),
  positions: z.number().int().min(1).max(1_000_000).optional(),
});

export async function POST(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;

  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = ActionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  const body = parsed.data;

  // --- Single queue-move actions (per-campaign) ---
  if (body.action === "move_to_top" || body.action === "move_up") {
    if (!body.id || !body.campaignId) {
      return NextResponse.json({ error: "invalid_input" }, { status: 400 });
    }
    try {
      const moved = await moveSignup(
        ctx,
        body.campaignId,
        body.id,
        body.action,
        body.positions ?? 1,
      );
      if (!moved) return NextResponse.json({ error: "not_movable" }, { status: 409 });
      return NextResponse.json({ ok: true, action: body.action, rank: moved.rank });
    } catch {
      return NextResponse.json({ error: "move_failed" }, { status: 400 });
    }
  }

  // --- Bulk lifecycle actions (offboard / delete) ---
  if (!body.ids?.length) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  const repo = forTenant(ctx).signups;
  const now = new Date().toISOString();

  let updated = 0;
  const failed: string[] = [];
  for (const id of body.ids) {
    try {
      const existing = await repo.getById(id);
      if (!existing) {
        failed.push(id);
        continue;
      }

      if (body.action === "offboard") {
        await repo.update(id, { status: "offboarded", removedDate: now });
        // Reflect on the CRM contact — RETAIN it, just flag offboarded. Awaited
        // (fast Firestore write) but never fails the offboard.
        await recordSignupContactStatus(ctx, { ...existing, status: "offboarded" }).catch(
          (e) => console.warn(`contact offboard sync ${id}:`, e),
        );
        // Notify them — async (per-campaign toggle decided in the worker), so a
        // bulk offboard never blocks on email sends. Idempotent via dedupeKey.
        if (existing.email) {
          await enqueueEmailJob(ctx, {
            type: "lifecycle",
            campaignId: existing.campaignId,
            dedupeKey: `offboard:${id}`,
            payload: { signupId: id },
          }).catch((e) => console.warn(`offboard email enqueue ${id}:`, e));
        }
      } else {
        // delete = operational purge (spam/test). Remove this campaign's link
        // from the CRM contact + recompute status (PII erasure stays the explicit
        // GDPR contact_erase path), and drop them from the external marketing sync.
        await repo.delete(id);
        await recordSignupContactStatus(ctx, existing, { remove: true }).catch((e) =>
          console.warn(`contact delete sync ${id}:`, e),
        );
        if (existing.email) {
          void removeSignupFromAudience(ctx, existing.email).catch(() => {});
        }
      }
      updated += 1;
    } catch {
      // Cross-tenant / missing ids are refused by the repository — record, skip.
      failed.push(id);
    }
  }

  return NextResponse.json({ ok: true, action: body.action, updated, failed });
}

/**
 * Improve a single signup's queue position by raising its additive `manualBoost`
 * (folded into effectiveReferralWeight — queue ranking only, never the public
 * leaderboard). Monotonic: the boost can only increase, so a move never demotes.
 * Returns the new 1-based rank, or null when the signup is not rank-eligible.
 */
async function moveSignup(
  ctx: TenantContext,
  campaignId: string,
  id: string,
  action: "move_to_top" | "move_up",
  positions: number,
): Promise<{ rank: number } | null> {
  const repo = forTenant(ctx).signups;
  const target = await repo.getById(id);
  // Only ranked (verified_active) signups in THIS campaign can be moved.
  if (
    !target ||
    target.campaignId !== campaignId ||
    target.status !== "verified_active"
  ) {
    return null;
  }

  // Same fetch + ordering as computeRanks (reuses the leaderboard composite
  // index), then an in-memory re-sort by effective weight (folds in the bonuses).
  const rows = await repo.find({
    where: [
      ["campaignId", "==", campaignId],
      ["status", "==", "verified_active"],
    ],
    orderBy: [
      ["amountReferred", "desc"],
      ["createdAt", "asc"],
    ],
  });
  rows.sort((a, b) => {
    const wa = effectiveReferralWeight(a);
    const wb = effectiveReferralWeight(b);
    if (wa !== wb) return wb - wa;
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  });

  const currentIndex = rows.findIndex((r) => r.id === id);
  if (currentIndex === -1) return null;
  const base = (target.amountReferred ?? 0) + (target.engagementBonus ?? 0);
  const existingBoost = target.manualBoost ?? 0;

  let neededWeight: number;
  if (action === "move_to_top") {
    neededWeight =
      rows.reduce((m, r) => Math.max(m, effectiveReferralWeight(r)), 0) + 1;
  } else {
    const targetIndex = Math.max(0, currentIndex - positions);
    if (targetIndex >= currentIndex) return { rank: currentIndex + 1 }; // already there
    // Land strictly ahead of whoever sits at the target index → overtake them.
    neededWeight = effectiveReferralWeight(rows[targetIndex]!) + 1;
  }

  const newBoost = Math.max(existingBoost, neededWeight - base);
  if (newBoost === existingBoost) return { rank: currentIndex + 1 }; // no change

  await repo.update(id, { manualBoost: newBoost });

  // New rank = (# strictly ahead) + 1, with the boost applied.
  const newWeight = base + newBoost;
  let ahead = 0;
  for (const r of rows) {
    if (r.id === id) continue;
    const w = effectiveReferralWeight(r);
    if (w > newWeight || (w === newWeight && r.createdAt < target.createdAt)) ahead++;
  }
  return { rank: ahead + 1 };
}
