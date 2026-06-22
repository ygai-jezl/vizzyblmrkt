import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import { enqueueBroadcast, cancelScheduledBroadcast } from "@/lib/email/delivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A year out is the furthest a scheduled send may be queued. */
const MAX_SCHEDULE_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;

const ScheduleSchema = z.object({
  // Require an absolute instant: parseable AND carrying a timezone designator
  // (trailing Z or ±HH:MM). A tz-less local string would be read in the server's
  // timezone, silently shifting the send time — reject it.
  scheduledAt: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), "invalid datetime")
    .refine((s) => /([zZ]|[+-]\d{2}:?\d{2})$/.test(s.trim()), "missing timezone"),
});

type RouteParams = {
  params: Promise<{ campaignId: string; broadcastId: string }>;
};

/**
 * Schedule a broadcast to send at a future time. Unlike `/send` (which queues +
 * drains the worker inline so it goes out now), this only queues the job with a
 * future `scheduledAt`; the delivery worker (Cloud Scheduler cron) sends it once
 * that time is reached. Re-scheduling an already-scheduled broadcast re-times the
 * existing job. Valid from a draft, a failed, or an already-scheduled broadcast.
 */
export async function POST(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { campaignId, broadcastId } = await params;
  const broadcast = await forTenant(ctx).broadcasts.getById(broadcastId);
  if (!broadcast || broadcast.campaignId !== campaignId) {
    return NextResponse.json({ error: "broadcast_not_found" }, { status: 404 });
  }
  // Only a not-yet-dispatched broadcast can be (re)scheduled. queued/sending are
  // already on their way to the worker; sent is terminal.
  if (
    broadcast.status === "queued" ||
    broadcast.status === "sending" ||
    broadcast.status === "sent"
  ) {
    return NextResponse.json({ error: "not_schedulable" }, { status: 409 });
  }
  // A closed (archived) launch never sends — the worker would consume the job
  // without dispatching, leaving the broadcast stuck. Refuse up front.
  const campaign = await forTenant(ctx).campaigns.getById(campaignId);
  if (!campaign) {
    return NextResponse.json({ error: "campaign_not_found" }, { status: 404 });
  }
  if (campaign.archivedAt) {
    return NextResponse.json({ error: "launch_archived" }, { status: 409 });
  }

  const parsed = ScheduleSchema.safeParse(await req.json().catch(() => null));
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

  const whenMs = Date.parse(parsed.data.scheduledAt);
  const nowMs = Date.now();
  if (whenMs <= nowMs) {
    return NextResponse.json({ error: "must_be_future" }, { status: 400 });
  }
  if (whenMs > nowMs + MAX_SCHEDULE_AHEAD_MS) {
    return NextResponse.json({ error: "too_far_ahead" }, { status: 400 });
  }
  // Normalise to an ISO instant so display + the queued job agree exactly.
  const scheduledAt = new Date(whenMs).toISOString();

  await forTenant(ctx).broadcasts.update(broadcastId, {
    status: "scheduled",
    scheduledAt,
    lastError: null,
  });
  // Queue (or re-time) the job WITHOUT kicking the worker — the future
  // scheduledAt is what holds it until due.
  await enqueueBroadcast(ctx, broadcastId, campaignId, scheduledAt);

  return NextResponse.json({ ok: true, status: "scheduled", scheduledAt });
}

/** Cancel a scheduled broadcast: drop its queued job and return it to draft. */
export async function DELETE(req: Request, { params }: RouteParams) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { campaignId, broadcastId } = await params;
  const broadcast = await forTenant(ctx).broadcasts.getById(broadcastId);
  if (!broadcast || broadcast.campaignId !== campaignId) {
    return NextResponse.json({ error: "broadcast_not_found" }, { status: 404 });
  }
  if (broadcast.status !== "scheduled") {
    return NextResponse.json({ error: "not_scheduled" }, { status: 409 });
  }

  // Delete the job FIRST so the send is stopped even if the status write below
  // fails; if the worker already claimed it, this returns false (too late).
  const cancelled = await cancelScheduledBroadcast(ctx, broadcastId);
  if (!cancelled) {
    return NextResponse.json({ error: "already_sending" }, { status: 409 });
  }
  await forTenant(ctx).broadcasts.update(broadcastId, {
    status: "draft",
    scheduledAt: null,
  });

  return NextResponse.json({ ok: true, status: "draft" });
}
