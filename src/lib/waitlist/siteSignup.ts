import { forTenant, getTenantById, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { Campaign } from "@/lib/types/campaign";
import { resolveProductName } from "@/lib/types/campaign";
import type { Signup } from "@/lib/types/signup";
import type { SiteKey } from "@/lib/types/siteKey";
import type { Tenant } from "@/lib/types/tenant";
import { sendEmail, type EmailMessage, type EmailResult } from "@/lib/email";
import { verificationEmail } from "@/lib/email/templates";
import { resolveSender } from "@/lib/email/sender";
import { resolveTransactionalEmailStyle } from "@/lib/email/resolveEmailStyle";
import { emailLinkOrigin } from "@/lib/email/footer";
import { liftUnsubscribe, suppressionReasonOf } from "@/lib/email/suppression";
import { appendTenantParam } from "@/lib/http/tenantParam";
import { resolveVisitorLocale } from "@/lib/i18n/locale";
import { syncSignupToAudience, syncSignupToWeekly } from "@/lib/mailchimp";
import { journeyIdFor } from "@/lib/journey/service";
import { launchEngine } from "@/lib/journey/launchJourney";
import { waitlistJourneyId } from "@/lib/lifecycle/waitlist/ids";
import { versionDocId } from "@/lib/lifecycle/enrol";
import { isClosed } from "./closed";
import { generateVerificationToken, normalizeEmail } from "./identifiers";
import { createSignup } from "./signupService";
import { afterVerify } from "./afterVerify";
import { recordSiteKeyUse } from "./siteKeys";
import { SITE_SIGNUP_LIMITS, type SiteSignupReply, type SiteSignupRequest } from "./siteSignupContract";

/**
 * Sign-ups from a brand's own site (LAUNCH_SITE_SIGNUPS_ENABLED). The brand's server
 * adds an email to its site key's launch; YouGrow always sends the confirmation, and
 * nobody joins until they press Confirm subscription on YouGrow's page. Once they do,
 * they're like anyone who joined the launch: its journey, its broadcasts and, once
 * they reach its weekly step, the weekly newsletter.
 *
 * Rules: at most one confirmation per address per launch a day; an address that
 * bounced or reported the brand as spam is never emailed; someone who unsubscribed
 * gets the confirmation, and confirming lifts their (brand-wide) unsubscribe.
 */

export interface SiteSignupDeps {
  db?: FirestoreLike;
  nowMs?: number;
  /** Tests inject the provider. */
  send?: (msg: EmailMessage) => Promise<EmailResult>;
}

export type SiteSignupOutcome =
  | { ok: true; reply: SiteSignupReply }
  /** launch_closed: archived or gone (409). unauthorized: the brand is suspended (401). email_unavailable: can't send now (503). */
  | { ok: false; error: "launch_closed" | "unauthorized" | "email_unavailable" };

const iso = (ms: number) => new Date(ms).toISOString();

/** A provider that may have taken the message counts as sent: never risk a second email. */
function wasSent(r: EmailResult): boolean {
  return r.sent || r.ambiguous === true || Boolean(process.env.FIRESTORE_EMULATOR_HOST);
}

/** The link in the confirmation email: always YouGrow's own address, never one from the request. */
export function siteConfirmUrl(origin: string, tenantId: string, campaignId: string, token: string): string {
  return appendTenantParam(
    `${origin}/waitlist/${encodeURIComponent(campaignId)}/confirm?token=${encodeURIComponent(token)}`,
    tenantId,
  );
}

async function sendConfirmation(
  ctx: TenantContext,
  campaign: Campaign,
  tenant: Tenant,
  signup: Signup,
  token: string,
  origin: string,
  deps: SiteSignupDeps,
): Promise<boolean> {
  if (!signup.email) return false;
  const email = {
    to: signup.email,
    waitlistName: resolveProductName(campaign),
    firstName: signup.firstName,
    verifyUrl: siteConfirmUrl(origin, ctx.tenantId, campaign.id, token),
    locale: signup.locale,
    kind: "newsletter" as const,
  };
  let message = verificationEmail(email);
  try {
    const style = resolveTransactionalEmailStyle(tenant);
    if (style) message = verificationEmail({ ...email, style });
  } catch (err) {
    console.warn(`[site-signups] styled confirmation failed for ${campaign.id}, sending it plain:`, err);
  }
  const sender = resolveSender(tenant, campaign);
  try {
    const r = await (deps.send ?? sendEmail)({ ...message, fromEmail: sender.fromEmail, fromName: sender.fromName, replyTo: sender.replyTo });
    return wasSent(r);
  } catch (err) {
    console.warn(`[site-signups] confirmation failed for ${campaign.id}:`, err);
    return false;
  }
}

/** POST /api/v2/signups, once the key is checked: `key` names the launch. */
export async function addSiteSignup(
  ctx: TenantContext,
  key: SiteKey,
  body: SiteSignupRequest,
  deps: SiteSignupDeps = {},
): Promise<SiteSignupOutcome> {
  const nowMs = deps.nowMs ?? Date.now();
  const now = iso(nowMs);
  const repo = forTenant(ctx, deps.db);
  const campaign = await repo.campaigns.getById(key.campaignId);
  if (!campaign || isClosed(campaign)) return { ok: false, error: "launch_closed" };
  const tenant = await getTenantById(ctx.tenantId, deps.db).catch(() => null);
  if (!tenant || tenant.status === "suspended") return { ok: false, error: "unauthorized" };
  const origin = emailLinkOrigin();
  if (!origin) return { ok: false, error: "email_unavailable" };

  const email = normalizeEmail(body.email);
  const suppressed = await suppressionReasonOf(ctx, email, deps.db);
  if (suppressed === "spam" || suppressed === "hard_bounce") {
    return { ok: true, reply: { status: "not_sent", reason: "blocked" } };
  }

  const { signup, alreadyJoined } = await createSignup(
    ctx,
    campaign,
    { email, ...(body.firstName ? { firstName: body.firstName } : {}) },
    {
      db: deps.db,
      now,
      requireVerification: true,
      hostedPageBaseUrl: origin,
      tenantId: ctx.tenantId,
      locale: resolveVisitorLocale({ explicit: body.locale, campaign, tenant }),
      extra: { joinedVia: "site", siteSource: body.source ?? null, confirmationSentAt: now },
    },
  );

  if (!alreadyJoined) {
    const sent = await sendConfirmation(ctx, campaign, tenant, signup, signup.verificationToken!, origin, deps);
    if (!sent) {
      // Let the next call try again straight away.
      await repo.signups.update(signup.id, { confirmationSentAt: null }).catch(() => {});
      return { ok: false, error: "email_unavailable" };
    }
    await recordSiteKeyUse(ctx, campaign.id, { newSignup: true }, { db: deps.db, nowMs });
    return { ok: true, reply: { status: "confirmation_sent" } };
  }

  await recordSiteKeyUse(ctx, campaign.id, { newSignup: false }, { db: deps.db, nowMs });
  if (signup.status === "offboarded" || signup.status === "deleted") {
    return { ok: true, reply: { status: "not_sent", reason: "removed" } };
  }
  const backAgain = suppressed === "unsubscribe";
  if (signup.status === "verified_active" && !backAgain) {
    return { ok: true, reply: { status: "already_confirmed" } };
  }

  // Not confirmed yet, or confirmed but since unsubscribed (asking again): one email a day.
  const before = signup.confirmationSentAt ?? null;
  const claimed = await repo.signups.claim(signup.id, (cur) => {
    if (cur.confirmationSentAt && nowMs - Date.parse(cur.confirmationSentAt) < SITE_SIGNUP_LIMITS.resendAfterMs) return null;
    // Asking a confirmed person again gets a fresh token; an unconfirmed one keeps theirs.
    const freshToken = cur.status === "verified_active" || !cur.verificationToken;
    return { confirmationSentAt: now, ...(freshToken ? { verificationToken: generateVerificationToken() } : {}) };
  });
  if (!claimed) return { ok: true, reply: { status: "not_sent", reason: "recently_sent" } };
  const sent = await sendConfirmation(ctx, campaign, tenant, claimed, claimed.verificationToken!, origin, deps);
  if (!sent) {
    await repo.signups.update(signup.id, { confirmationSentAt: before }).catch(() => {});
    return { ok: false, error: "email_unavailable" };
  }
  return { ok: true, reply: { status: "confirmation_sent" } };
}

// ---- The Confirm subscription page ------------------------------------------------

export type SiteConfirmState =
  /** Ready to confirm. `backAgain`: they unsubscribed before; confirming lifts it brand-wide. */
  | { state: "ready"; backAgain: boolean; locale: string | null }
  | { state: "done"; locale: string | null }
  | { state: "blocked" }
  | { state: "invalid" };

async function signupByToken(ctx: TenantContext, campaignId: string, token: string, db?: FirestoreLike): Promise<Signup | null> {
  if (!token) return null;
  const rows = await forTenant(ctx, db).signups.find({
    where: [
      ["campaignId", "==", campaignId],
      ["verificationToken", "==", token],
    ],
    limit: 1,
  });
  const s = rows[0];
  return s && s.email && s.status !== "offboarded" && s.status !== "deleted" ? s : null;
}

/** What the confirm page shows for a token, before anyone presses anything. Reads only. */
export async function peekSiteConfirm(
  ctx: TenantContext,
  campaignId: string,
  token: string,
  db?: FirestoreLike,
): Promise<SiteConfirmState> {
  const signup = await signupByToken(ctx, campaignId, token, db);
  if (!signup) return { state: "invalid" };
  const reason = await suppressionReasonOf(ctx, signup.email, db);
  if (reason === "spam" || reason === "hard_bounce") return { state: "blocked" };
  const backAgain = reason === "unsubscribe";
  const locale = signup.locale ?? null;
  if (signup.status === "verified_active" && !backAgain) return { state: "done", locale };
  return { state: "ready", backAgain, locale };
}

/**
 * Whether the launch's live journey hands people to its weekly newsletter, on
 * whichever engine it runs. Someone confirming again after unsubscribing goes
 * straight back on the weekly list: a journey takes a person only once.
 */
export async function launchHasWeeklyStep(ctx: TenantContext, campaign: Campaign, db?: FirestoreLike): Promise<boolean> {
  const repo = forTenant(ctx, db);
  if (launchEngine(campaign) === "lifecycle") {
    const journey = await repo.lifecycleJourneys.getById(waitlistJourneyId(campaign.id));
    if (!journey?.publishedVersion || journey.status !== "active") return false;
    const version = await repo.lifecycleVersions.getById(versionDocId(journey.id, journey.publishedVersion));
    return Boolean(version?.graph.nodes.some((n) => n.type === "exit" && n.data.exitTarget === "weekly"));
  }
  const journey = await repo.journeys.getById(journeyIdFor(campaign.id));
  if (!journey || journey.status !== "active") return false;
  return journey.graph.nodes.some((n) => n.type === "exit" && n.data.exitTargetKind === "weekly");
}

export type SiteConfirmResult =
  | { outcome: "confirmed"; campaign: Campaign; backAgain: boolean; locale: string | null }
  | { outcome: "already"; campaign: Campaign; locale: string | null }
  | { outcome: "blocked" | "invalid" };

/** Someone pressed Confirm subscription. Safe to repeat. */
export async function confirmSiteSignup(
  ctx: TenantContext,
  campaignId: string,
  token: string,
  deps: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<SiteConfirmResult> {
  const repo = forTenant(ctx, deps.db);
  const campaign = await repo.campaigns.getById(campaignId);
  if (!campaign) return { outcome: "invalid" };
  const signup = await signupByToken(ctx, campaignId, token, deps.db);
  if (!signup) return { outcome: "invalid" };
  const reason = await suppressionReasonOf(ctx, signup.email, deps.db);
  if (reason === "spam" || reason === "hard_bounce") return { outcome: "blocked" };
  const backAgain = reason === "unsubscribe";
  const now = iso(deps.nowMs ?? Date.now());
  const wasConfirmed = signup.status === "verified_active";
  const claimed = await repo.signups.claim(signup.id, (cur) => {
    if (cur.verificationToken !== token) return null;
    const back = backAgain ? { resubscribedAt: now, unsubscribedAt: null } : {};
    if (cur.status === "unverified") return { verified: true, status: "verified_active", ...back };
    if (cur.status === "verified_active" && backAgain) return back;
    return null;
  });
  const locale = signup.locale ?? null;
  if (!claimed) return wasConfirmed ? { outcome: "already", campaign, locale } : { outcome: "invalid" };

  if (backAgain) await liftUnsubscribe(ctx, signup.email!, deps.db);
  if (!wasConfirmed) {
    await afterVerify(ctx, campaign, claimed, { resubscribe: backAgain });
    return { outcome: "confirmed", campaign, backAgain, locale };
  }
  // Confirmed before, unsubscribed, now back: onto the list again, and the weekly list
  // if the journey has a weekly step (it won't take them a second time).
  try {
    await syncSignupToAudience(ctx, campaign, claimed, { resubscribe: true });
    if (await launchHasWeeklyStep(ctx, campaign, deps.db)) await syncSignupToWeekly(ctx, campaign, claimed, { resubscribe: true });
  } catch (err) {
    console.warn(`[site-signups] re-adding ${campaign.id} to the newsletter failed:`, err);
  }
  return { outcome: "confirmed", campaign, backAgain, locale };
}
