import { getTenantById } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { Campaign } from "@/lib/types/campaign";
import type { Signup } from "@/lib/types/signup";
import { resolveMailchimpConfig } from "./config";
import { upsertMember, archiveMember } from "./client";
import type { MailchimpResult } from "./types";

/**
 * Stable per-launch tag. Used both to tag synced subscribers and to scope
 * Broadcasts / Journeys to a single launch's audience.
 */
export function campaignTag(campaignId: string): string {
  return `waitlist-${campaignId}`;
}

/**
 * Stable per-launch WEEKLY-newsletter tag. Applied when a subscriber reaches a
 * "weekly" Exit node; scopes the recurring weekly-newsletter Broadcast to the
 * opt-in subset (vs. campaignTag, which is the whole launch). A MailChimp tag
 * IS a static segment, so tagging the first member makes it findable.
 */
export function weeklyTag(campaignId: string): string {
  return `weekly-${campaignId}`;
}

/**
 * Merge fields pushed to MailChimp. We deliberately do NOT push waitlist RANK
 * here — rank changes constantly and computing it per-signup is a full scan;
 * it's resolved at email-send time instead (see src/lib/email/mergeVars.ts).
 */
function mergeFieldsFor(signup: Signup): Record<string, string | number> {
  const fields: Record<string, string | number> = {
    REFCOUNT: signup.amountReferred ?? 0,
  };
  if (signup.firstName) fields.FNAME = signup.firstName;
  if (signup.lastName) fields.LNAME = signup.lastName;
  if (signup.referralLink) fields.REFLINK = signup.referralLink;
  return fields;
}

/**
 * Best-effort: upsert a verified signup into the tenant's MailChimp audience,
 * tagged by launch so Broadcasts & Journeys can target it. Never throws — the
 * caller's flow (signup / verify) must not fail on a sync hiccup.
 */
export async function syncSignupToAudience(
  ctx: TenantContext,
  campaign: Campaign,
  signup: Signup,
): Promise<MailchimpResult> {
  if (!signup.email) return { ok: false, reason: "no_email" };
  const tenant = await getTenantById(ctx.tenantId).catch(() => null);
  const resolved = resolveMailchimpConfig(tenant);
  if (!resolved.ok) {
    console.warn(
      `[mailchimp] audience sync skipped (${resolved.reason}) for ${campaign.id}`,
    );
    return { ok: false, reason: resolved.reason };
  }
  return upsertMember(resolved.config, {
    email: signup.email,
    status: "subscribed",
    mergeFields: mergeFieldsFor(signup),
    tags: [campaignTag(campaign.id)],
  });
}

/**
 * Best-effort: subscribe a verified signup to the launch's WEEKLY-newsletter
 * audience by adding the weekly tag. Additive — does NOT remove the waitlist
 * tag. Idempotent (upsertMember is a PUT by subscriber hash; addTags sets
 * status:"active"). Never throws, so a worker retry re-tags harmlessly.
 */
export async function syncSignupToWeekly(
  ctx: TenantContext,
  campaign: Campaign,
  signup: Signup,
): Promise<MailchimpResult> {
  if (!signup.email) return { ok: false, reason: "no_email" };
  const tenant = await getTenantById(ctx.tenantId).catch(() => null);
  const resolved = resolveMailchimpConfig(tenant);
  if (!resolved.ok) {
    console.warn(
      `[mailchimp] weekly sync skipped (${resolved.reason}) for ${campaign.id}`,
    );
    return { ok: false, reason: resolved.reason };
  }
  return upsertMember(resolved.config, {
    email: signup.email,
    status: "subscribed",
    mergeFields: mergeFieldsFor(signup),
    tags: [weeklyTag(campaign.id)],
  });
}

/** Best-effort: archive a member when they're offboarded / deleted. */
export async function removeSignupFromAudience(
  ctx: TenantContext,
  email: string | null | undefined,
): Promise<MailchimpResult> {
  if (!email) return { ok: false, reason: "no_email" };
  const tenant = await getTenantById(ctx.tenantId).catch(() => null);
  const resolved = resolveMailchimpConfig(tenant);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  return archiveMember(resolved.config, email);
}
