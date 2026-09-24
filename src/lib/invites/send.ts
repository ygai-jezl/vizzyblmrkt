import { forTenant, getTenantById } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { EmailJob } from "@/lib/types/emailJob";
import type { Invite } from "@/lib/types/invite";
import { sendEmail } from "@/lib/email";
import { resolveSender } from "@/lib/email/sender";
import { emailLinkOrigin, journeyFooterValues, unsubscribeLinks } from "@/lib/email/footer";
import { isSuppressed } from "@/lib/email/suppression";
import { recordEmailEvent } from "@/lib/email/events";
import { resolveCampaignLocale } from "@/lib/i18n/locale";
import { offboardSignup } from "@/lib/waitlist/offboard";
import { inviteConnections, inviteProductName } from "./eligibility";
import { isInvitesEnabled } from "./flags";
import { renderInviteEmail } from "./render";
import { inviteLinkUrl, signInviteToken } from "./token";

/**
 * Send one invite (email job type "invite", nav v2 phase 4).
 *
 * Order matters:
 * 1. Anyone who can't be invited any more (unsubscribed, no longer verified,
 *    launch archived, product gone) is SKIPPED and stays on the waitlist.
 * 2. The email is sent once: `emailSentAt` on the job is the guard, so a retry
 *    after a later failure never sends it again.
 * 3. Only after a sent (or ambiguous) result is the person marked invited and
 *    taken off the waitlist (offboarded, reason "invited", no offboarding email).
 *
 * Returns "hold" while invites are switched off, so queued invites wait rather
 * than being dropped.
 */

/** Emails from invites are grouped under this id in email analytics (never the welcome journey's). */
export function inviteJourneyId(campaignId: string): string {
  return `invite_${campaignId}`;
}

const DAY_MS = 86_400_000;

export async function processInviteJob(
  ctx: TenantContext,
  job: EmailJob,
  db?: FirestoreLike,
): Promise<"done" | "hold"> {
  if (!isInvitesEnabled()) return "hold";
  const repos = forTenant(ctx, db);
  const inviteId = String(job.payload.inviteId ?? "");
  const invite = await repos.invites.getById(inviteId);
  if (!invite) return "done"; // erased, or the launch was deleted

  const nowIso = new Date().toISOString();
  if (job.emailSentAt) {
    // Sent on an earlier attempt that failed afterwards: finish the bookkeeping only.
    await markInvitedAndOffboard(ctx, invite, nowIso, db);
    return "done";
  }
  if (invite.status !== "queued") return "done"; // cancelled, skipped or already sent

  const skip = async (reason: string) => {
    await repos.invites.claim(invite.id, (cur) =>
      cur.status === "queued" ? { status: "skipped" as const, skipReason: reason, updatedAt: nowIso } : null,
    );
    return "done" as const;
  };

  const wave = await repos.inviteWaves.getById(invite.waveId);
  if (!wave || wave.status === "cancelled") {
    await repos.invites.claim(invite.id, (cur) =>
      cur.status === "queued" ? { status: "cancelled" as const, skipReason: "cancelled", updatedAt: nowIso } : null,
    );
    return "done";
  }
  const signup = await repos.signups.getById(invite.signupId);
  if (!signup) return skip("left_waitlist");
  if (!signup.email) return skip("no_email");
  if (signup.status !== "verified_active") return skip("left_waitlist");
  if (await isSuppressed(ctx, signup.email, db)) return skip("unsubscribed");
  const campaign = await repos.campaigns.getById(invite.campaignId);
  if (!campaign) throw new Error("campaign_not_found");
  if (campaign.archivedAt) return skip("launch_archived");
  const connection = await repos.productConnections.getById(invite.connectionId);
  if (!connection || inviteConnections([connection]).length === 0) return skip("product_unavailable");

  const origin = emailLinkOrigin();
  if (!origin) throw new Error("invite_link_origin_unconfigured");
  // Fix the expiry once (before sending), so a retry mints a link with the same expiry.
  const expiresAt = invite.expiresAt ?? new Date(Date.now() + wave.expiresInDays * DAY_MS).toISOString();
  if (!invite.expiresAt) await repos.invites.update(invite.id, { expiresAt, updatedAt: nowIso });
  const token = signInviteToken({ tenantId: ctx.tenantId, inviteId: invite.id, expiresAtMs: Date.parse(expiresAt) });

  const tenant = await getTenantById(ctx.tenantId).catch(() => null);
  const unsub = unsubscribeLinks({
    tenantId: ctx.tenantId,
    campaignId: campaign.id,
    signupId: signup.id,
    email: signup.email,
  });
  const footer = journeyFooterValues({ tenant, campaign, unsubscribeUrl: unsub.pageUrl });
  // Rank isn't computed for invites ({{current_rank}} renders blank): it's a full
  // waitlist scan per email, and the person is leaving the waitlist anyway.
  const rendered = renderInviteEmail({
    subject: wave.subject,
    body: wave.body,
    heroImageUrl: wave.heroImageUrl ?? null,
    merge: { signup, campaign, footer },
    inviteUrl: inviteLinkUrl(origin, token),
    productName: inviteProductName(connection),
    expiresInDays: wave.expiresInDays,
    locale: signup.locale ?? resolveCampaignLocale(campaign, tenant),
  });
  const sender = resolveSender(tenant, campaign);
  const journeyId = inviteJourneyId(campaign.id);
  const res = await sendEmail({
    to: signup.email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    fromEmail: sender.fromEmail,
    fromName: sender.fromName,
    replyTo: sender.replyTo,
    ...(unsub.apiUrl ? { listUnsubscribe: { url: unsub.apiUrl, oneClick: true } } : {}),
    track: { opens: true, clicks: true },
    metadata: {
      tenantId: ctx.tenantId,
      campaignId: campaign.id,
      journeyId,
      nodeId: wave.id,
      signupId: signup.id,
      variantId: "control",
    },
    tags: ["invite", `wave-${wave.id}`],
  });
  // The log provider (dev, no key) counts as sent. An AMBIGUOUS result may have
  // gone out, so it is treated as sent too — never retried.
  if (!res.sent && res.provider !== "log" && !res.ambiguous) throw new Error(`send:${res.reason ?? "failed"}`);
  await repos.emailJobs.update(job.id, {
    emailSentAt: new Date().toISOString(),
    mandrillMessageId: res.id ?? null,
    ...(res.ambiguous ? { sendAmbiguous: res.reason ?? "unknown" } : {}),
  });
  await recordEmailEvent(
    ctx,
    {
      campaignId: campaign.id,
      journeyId,
      nodeId: wave.id,
      signupId: signup.id,
      variantId: "control",
      type: "send",
      ts: new Date().toISOString(),
      mandrillMessageId: res.id ?? null,
    },
    db,
  ).catch(() => {});
  await markInvitedAndOffboard(ctx, invite, new Date().toISOString(), db);
  return "done";
}

/** After the send: mark the invite sent (forward-only) and take the person off the waitlist. Idempotent. */
async function markInvitedAndOffboard(ctx: TenantContext, invite: Invite, now: string, db?: FirestoreLike) {
  const repos = forTenant(ctx, db);
  await repos.invites.claim(invite.id, (cur) =>
    cur.invited ? null : { status: "invited" as const, invited: true, invitedAt: now, updatedAt: now },
  );
  const signup = await repos.signups.getById(invite.signupId);
  if (signup && signup.status !== "offboarded" && signup.status !== "deleted") {
    await offboardSignup(ctx, signup, { reason: "invited", inviteId: invite.id, notify: false, now, db });
  }
}

/** When retries run out: record it on the invite. The person stays on the waitlist. */
export async function markInviteFailed(ctx: TenantContext, job: EmailJob, reason: string, db?: FirestoreLike) {
  const inviteId = String(job.payload.inviteId ?? "");
  if (!inviteId) return;
  const now = new Date().toISOString();
  await forTenant(ctx, db)
    .invites.claim(inviteId, (cur) =>
      cur.status === "queued" ? { status: "failed" as const, skipReason: reason.slice(0, 200), updatedAt: now } : null,
    )
    .catch(() => {});
}
