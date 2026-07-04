import type { Campaign } from "@/lib/types/campaign";
import type { EmailContent } from "@/lib/types/email";
import {
  renderMergeVars,
  toMailchimpMergeTags,
  type MergeContext,
} from "@/lib/email/mergeVars";
import {
  wrap,
  looksHtml,
  paragraphize,
  bodyToHtml,
  htmlToText,
  escapeHtml,
} from "@/lib/email/emailRender";

/**
 * Agent 4 — deterministic compiler / QA gate. Turns authored EmailContent into a
 * ready-to-send payload for the right channel:
 *   - compileBroadcast    → MailChimp campaign HTML (merge TAGS, audience-wide)
 *   - compileJourneyEmail → fully-rendered HTML for ONE recipient (Mandrill)
 * and runs a light brand-safety check (strictest for ENTERPRISE_TRUST).
 */
export interface CompiledEmail {
  subject: string;
  html: string;
  text?: string;
  warnings: string[];
}

/** Broadcast: recipients come from the audience; personalise via merge tags. */
export function compileBroadcast(
  content: EmailContent,
  campaign: Campaign,
): CompiledEmail {
  const subject = toMailchimpMergeTags(content.subject, campaign);
  const body = toMailchimpMergeTags(content.body, campaign);
  return {
    subject,
    html: wrap(bodyToHtml(body), content.heroImageUrl ?? null),
    warnings: qaWarnings(content, campaign),
  };
}

/** Journey step: render every {{var}} for the specific recipient. */
export function compileJourneyEmail(
  content: EmailContent,
  mergeCtx: MergeContext,
): CompiledEmail {
  // Subject is plain text (Mandrill's subject field) — render raw.
  const subject = renderMergeVars(content.subject, mergeCtx);
  // Body: escape the subscriber-controlled VALUES (firstName/metadata/…) to block
  // stored-XSS, but never the author's own markup. For an HTML template, escape
  // values at substitution and keep tags; for plain text, substitute raw then
  // escape the whole thing once (avoids double-escaping).
  const body = looksHtml(content.body)
    ? renderMergeVars(content.body, mergeCtx, escapeHtml)
    : paragraphize(escapeHtml(renderMergeVars(content.body, mergeCtx)));
  const html = wrap(body, content.heroImageUrl ?? null);
  return {
    subject,
    html,
    text: htmlToText(html),
    warnings: qaWarnings(content, mergeCtx.campaign),
  };
}

// ---- QA gate --------------------------------------------------------------

function qaWarnings(content: EmailContent, campaign: Campaign): string[] {
  const w: string[] = [];
  if (!content.subject.trim()) w.push("empty_subject");
  if (!content.body.trim()) w.push("empty_body");
  // ENTERPRISE_TRUST pairs with the strictest brand-safety gate (see campaign.ts).
  if (campaign.strategy?.brandTone === "ENTERPRISE_TRUST") {
    // `\p{Lu}` (any Unicode uppercase letter) catches shouting in every cased
    // script — Latin-with-accents, Greek, Cyrillic — not just ASCII. Caseless
    // scripts (Arabic, CJK, Hebrew, Devanagari) have no uppercase, so shouting
    // isn't expressible via case there and correctly never trips this check.
    if (/\p{Lu}{6,}/u.test(content.subject)) w.push("subject_shouting");
    // Count ASCII and full-width (CJK) exclamation marks.
    if ((content.subject.match(/[!！]/g)?.length ?? 0) > 1) {
      w.push("subject_excess_exclamation");
    }
  }
  return w;
}

// ---- HTML assembly ---------------------------------------------------------
// wrap/looksHtml/paragraphize/bodyToHtml/htmlToText/escapeHtml now live in
// src/lib/email/emailRender.ts (shared with the visual layout editor's preview).
