import { forTenant, getTenantById } from "@/lib/tenant";
import type { TenantContext, FirestoreLike } from "@/lib/tenant/types";
import { resolveMailchimpConfig, getCampaignReport } from "@/lib/mailchimp";
import type { CampaignReport } from "@/lib/mailchimp/client";
import type { Broadcast, BroadcastStats } from "@/lib/types/broadcast";

/** Server flag: keep all of MailChimp's report with a history, and keep syncing for 90 days. */
export function isMailchimpReportDetailEnabled(): boolean {
  return process.env.MAILCHIMP_REPORT_DETAIL_ENABLED === "true";
}

/** With the detail switch: synced daily for 14 days, then weekly until 90 days. */
const DETAIL_WINDOW_DAYS = 90;
const WEEKLY_AFTER_MS = 7 * 24 * 3600_000;
const HISTORY_MAX = 30;

/** The stats kept from one report. The 4 shown today are always written. Pure. */
export function statsOf(r: CampaignReport, detail: boolean, nowIso: string): BroadcastStats {
  return {
    emailsSent: r.emails_sent,
    openRate: r.opens?.open_rate,
    clickRate: r.clicks?.click_rate,
    unsubscribed: r.unsubscribed,
    ...(detail
      ? {
          uniqueOpens: r.opens?.unique_opens,
          totalOpens: r.opens?.opens_total,
          uniqueClicks: r.clicks?.unique_clicks,
          totalClicks: r.clicks?.clicks_total,
          hardBounces: r.bounces?.hard_bounces,
          softBounces: r.bounces?.soft_bounces,
          complaints: r.abuse_reports,
          forwards: r.forwards?.forwards_count,
          lastOpenAt: r.opens?.last_open || null,
          lastClickAt: r.clicks?.last_click || null,
          syncedAt: nowIso,
        }
      : {}),
  };
}

/** Whether a sent broadcast's report is due a sync now. Pure. */
export function reportDue(b: Pick<Broadcast, "sentAt" | "stats">, nowMs: number, detail: boolean): boolean {
  const sentMs = b.sentAt ? Date.parse(b.sentAt) : nowMs;
  const age = nowMs - sentMs;
  if (!detail) return age <= RECENT_WINDOW_DAYS * 24 * 3600_000;
  if (age > DETAIL_WINDOW_DAYS * 24 * 3600_000) return false;
  if (age <= RECENT_WINDOW_DAYS * 24 * 3600_000) return true;
  const last = b.stats?.syncedAt ? Date.parse(b.stats.syncedAt) : 0;
  return nowMs - last >= WEEKLY_AFTER_MS;
}

/** Only refresh reports for broadcasts sent within this window — older sends are
 *  stable, so re-pulling them every cron tick just burns MailChimp API calls. */
const RECENT_WINDOW_DAYS = 14;

/**
 * Pull MailChimp campaign reports (opens/clicks) for this tenant's recently-SENT
 * broadcasts and persist them onto `broadcast.stats`. Broadcasts deliver via
 * MailChimp Marketing (not Mandrill), so their engagement lives in MailChimp's
 * reports API, not our `email_events`. Best-effort: a per-broadcast failure is
 * swallowed so one bad report can never stall the rest (or the worker run).
 */
export async function syncBroadcastStats(
  ctx: TenantContext,
  db?: FirestoreLike,
  limit = 100,
): Promise<{ synced: number }> {
  const tenant = await getTenantById(ctx.tenantId).catch(() => null);
  const cfg = resolveMailchimpConfig(tenant);
  if (!cfg.ok) return { synced: 0 };

  const repo = forTenant(ctx, db).broadcasts;
  // Equality-only (tenantId + status) — no composite index required.
  const sent = await repo.find({ where: [["status", "==", "sent"]], limit });

  const detail = isMailchimpReportDetailEnabled();
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  let synced = 0;
  for (const b of sent) {
    if (!b.mailchimpCampaignId) continue;
    if (!reportDue(b, nowMs, detail)) continue; // stable or recently synced; skip
    const report = await getCampaignReport(cfg.config, b.mailchimpCampaignId).catch(
      () => null,
    );
    if (!report || !report.ok || !report.data) continue;
    const stats = statsOf(report.data, detail, nowIso);
    await repo
      .update(b.id, {
        stats,
        ...(detail ? { statsHistory: [...(b.statsHistory ?? []), stats].slice(-HISTORY_MAX) } : {}),
      })
      .catch(() => {});
    synced += 1;
  }
  return { synced };
}
