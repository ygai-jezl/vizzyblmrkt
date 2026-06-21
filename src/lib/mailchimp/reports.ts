import { forTenant, getTenantById } from "@/lib/tenant";
import type { TenantContext, FirestoreLike } from "@/lib/tenant/types";
import { resolveMailchimpConfig, getCampaignReport } from "@/lib/mailchimp";

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

  const cutoff = new Date(
    Date.now() - RECENT_WINDOW_DAYS * 24 * 3600_000,
  ).toISOString();
  let synced = 0;
  for (const b of sent) {
    if (!b.mailchimpCampaignId) continue;
    if (b.sentAt && b.sentAt < cutoff) continue; // stable; skip
    const report = await getCampaignReport(cfg.config, b.mailchimpCampaignId).catch(
      () => null,
    );
    if (!report || !report.ok || !report.data) continue;
    await repo
      .update(b.id, {
        stats: {
          emailsSent: report.data.emails_sent,
          openRate: report.data.opens?.open_rate,
          clickRate: report.data.clicks?.click_rate,
        },
      })
      .catch(() => {});
    synced += 1;
  }
  return { synced };
}
