import type { Signup } from "@/lib/types/signup";
import { resolveProductName, type Campaign } from "@/lib/types/campaign";
import { buildVoiceChatLink } from "@/lib/waitlist/voiceChatLink";
import { escapeHtml } from "@/lib/email/emailRender";

/**
 * Email merge variables. Authors write {{token}} in the composer; they are
 * rendered per-recipient for journey sends (Mandrill, full data incl. rank) and
 * translated to MailChimp merge tags for broadcasts (see lib/agents/compiler.ts).
 */
export const MERGE_VARS = [
  "first_name",
  "last_name",
  "referral_link",
  "referral_count",
  "current_rank",
  "waitlist_name",
  "voice_chat_link",
] as const;
export type MergeVar = (typeof MERGE_VARS)[number];

/**
 * Resolved values for the mandatory footer's internal tokens (sender_brand,
 * unsubscribe_url, manage_preferences_url, privacy_url). Built at send time in
 * the delivery worker (brand via resolveFooterBrand, a signed per-recipient
 * unsubscribe URL, the tenant's Privacy Policy URL) and threaded through the
 * compiler. These are NOT author-insertable tokens — they don't appear in
 * MERGE_VARS / the composer's merge menu.
 */
export interface FooterMergeValues {
  brand: string;
  unsubscribeUrl: string;
  managePreferencesUrl: string;
  privacyUrl: string;
}

export interface MergeContext {
  signup: Signup;
  campaign: Campaign;
  /** 1-based waitlist position; resolved at send time (see lib/waitlist/rank.ts). */
  rank?: number;
  /** Resolved footer identity + link URLs (journey path). */
  footer?: FooterMergeValues;
}

/** Match {{ token }} or {{ metadata.key }} (whitespace-tolerant). */
const TOKEN_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

/**
 * Render {{token}} placeholders to concrete values for one recipient. Pass an
 * `escape` fn when embedding into HTML — ONLY the substituted (subscriber-
 * controlled) value is escaped, never the author's surrounding template, so
 * stored values like firstName/metadata can't inject markup. See
 * lib/agents/compiler.ts (compileJourneyEmail passes escapeHtml).
 */
export function renderMergeVars(
  template: string,
  ctx: MergeContext,
  escape?: (s: string) => string,
): string {
  return template.replace(TOKEN_RE, (_m, key: string) => {
    const v = lookup(key, ctx);
    const s = v == null ? "" : String(v);
    return escape ? escape(s) : s;
  });
}

function lookup(key: string, ctx: MergeContext): unknown {
  if (key.startsWith("metadata.")) {
    return ctx.signup.metadata?.[key.slice("metadata.".length)];
  }
  switch (key) {
    case "first_name":
      return ctx.signup.firstName ?? "";
    case "last_name":
      return ctx.signup.lastName ?? "";
    case "referral_link":
      return ctx.signup.referralLink ?? "";
    case "referral_count":
      return ctx.signup.amountReferred ?? 0;
    case "current_rank":
      return ctx.rank ?? "";
    case "waitlist_name":
      // Resolves to the founder-set product name (falls back to the headline) so
      // body copy reads naturally — see resolveProductName in types/campaign.ts.
      return resolveProductName(ctx.campaign);
    case "voice_chat_link":
      // Per-recipient deep link that opens the waitlist page and auto-launches
      // the post-signup voice chat. Blank when the launch has voice disabled.
      return buildVoiceChatLink(ctx.signup, ctx.campaign);
    // Mandatory-footer tokens (resolved from ctx.footer, built in the delivery
    // worker). Internal — not in MERGE_VARS / the author merge menu.
    case "sender_brand":
      return ctx.footer?.brand ?? "";
    case "unsubscribe_url":
      return ctx.footer?.unsubscribeUrl ?? "";
    case "manage_preferences_url":
      return ctx.footer?.managePreferencesUrl ?? "";
    case "privacy_url":
      return ctx.footer?.privacyUrl ?? "";
    default:
      return "";
  }
}

/**
 * MailChimp merge-tag equivalents for the broadcast path. `current_rank` has no
 * MailChimp merge field (rank isn't synced to the audience — it changes
 * constantly), so it can't be personalised in a broadcast; it renders blank.
 */
const MAILCHIMP_TAGS: Record<MergeVar, string> = {
  first_name: "*|FNAME|*",
  last_name: "*|LNAME|*",
  referral_link: "*|REFLINK|*",
  referral_count: "*|REFCOUNT|*",
  current_rank: "",
  // Not synced to the audience yet (journeys-first); renders blank in broadcasts.
  voice_chat_link: "",
  waitlist_name: "",
};

/**
 * Translate our {{tokens}} into MailChimp merge tags for a broadcast body. The
 * footer's Unsubscribe / Manage-preferences map to MailChimp's NATIVE tags so
 * the campaign stays provider-compliant (MailChimp won't append a second
 * footer); sender_brand / privacy_url are campaign/tenant constants resolved in
 * the delivery worker and passed via `footer`.
 */
export function toMailchimpMergeTags(
  template: string,
  campaign: Campaign,
  footer?: FooterMergeValues,
): string {
  return template.replace(TOKEN_RE, (_m, key: string) => {
    if (key === "waitlist_name") return resolveProductName(campaign);
    // Footer identity values are tenant-controlled (brand/privacy URL) and land
    // inside footer markup/href — escape them here (the journey path escapes via
    // renderMergeVars(escapeHtml); this path has no such wrapper). The MailChimp
    // *|...|* tags are our own constants, emitted verbatim.
    if (key === "sender_brand") return escapeHtml(footer?.brand ?? "");
    if (key === "unsubscribe_url") return "*|UNSUB|*";
    if (key === "manage_preferences_url") return "*|UPDATE_PROFILE|*";
    if (key === "privacy_url") return escapeHtml(footer?.privacyUrl ?? "");
    if (key.startsWith("metadata.")) return ""; // not available as a list field
    return MAILCHIMP_TAGS[key as MergeVar] ?? "";
  });
}
