import type { Signup } from "@/lib/types/signup";
import { resolveProductName, type Campaign } from "@/lib/types/campaign";

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
] as const;
export type MergeVar = (typeof MERGE_VARS)[number];

export interface MergeContext {
  signup: Signup;
  campaign: Campaign;
  /** 1-based waitlist position; resolved at send time (see lib/waitlist/rank.ts). */
  rank?: number;
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
  waitlist_name: "",
};

/** Translate our {{tokens}} into MailChimp merge tags for a broadcast body. */
export function toMailchimpMergeTags(template: string, campaign: Campaign): string {
  return template.replace(TOKEN_RE, (_m, key: string) => {
    if (key === "waitlist_name") return resolveProductName(campaign);
    if (key.startsWith("metadata.")) return ""; // not available as a list field
    return MAILCHIMP_TAGS[key as MergeVar] ?? "";
  });
}
