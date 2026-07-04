import type { Signup } from "@/lib/types/signup";
import type { Campaign } from "@/lib/types/campaign";

/**
 * Build the per-recipient link that opens the waitlist page and auto-launches
 * the post-signup Gemini Live voice chat (the "boost your spot" modal). Powers
 * the {{voice_chat_link}} email merge var so a journey step can invite a signup
 * to start a voice chat straight from their inbox.
 *
 * Derived from the signup's stored `referralLink` — the single source of truth
 * for the already-resolved origin, path, and `t=` tenant hint — by swapping the
 * `?ref=` referral param for the voice deep-link params:
 *   - `rt=<referralToken>`: the proof-of-signup credential the token route
 *     expects (see api/waitlist/[campaignId]/conversation/token),
 *   - `voice=1`: tells the hosted page to resolve the signup and auto-open the
 *     chat modal (see app/waitlist/[campaignId]/page.tsx).
 * Any other existing params (notably the `t=` tenant hint on the shared host)
 * are preserved so the page + token route still resolve the tenant.
 *
 * Returns "" (a blank merge value) when: the launch has voice disabled; the
 * launch uses a custom external waitlist page (`waitlistUrlLocation`, the
 * brand's own site) that runs none of the `?voice=1` handling; or the signup
 * lacks the fields needed to build a valid link.
 */
export function buildVoiceChatLink(signup: Signup, campaign: Campaign): string {
  if (!campaign.aiConversation?.enabled) return "";
  // A custom external waitlist page is the brand's own site — it renders none of
  // the voice deep-link handling that lives only on our hosted /waitlist route
  // (see app/waitlist/[campaignId]/page.tsx), so the link would dead-end. Only
  // referral links that point at our hosted page can honor ?voice=1&rt=.
  if (campaign.waitlistUrlLocation) return "";
  if (!signup.referralLink || !signup.referralToken) return "";

  // Split on the FIRST "?" only, so a query value that itself contains "?"
  // survives (String.split("?") + destructuring would drop it).
  const q = signup.referralLink.indexOf("?");
  const base = q === -1 ? signup.referralLink : signup.referralLink.slice(0, q);
  const params = new URLSearchParams(q === -1 ? "" : signup.referralLink.slice(q + 1));
  params.delete("ref");
  params.set("rt", signup.referralToken);
  params.set("voice", "1");
  // Land in the language the email was sent in (the page reads ?lng before
  // Accept-Language) rather than re-negotiating from the recipient's browser.
  if (signup.locale) params.set("lng", signup.locale);
  return `${base}?${params.toString()}`;
}
