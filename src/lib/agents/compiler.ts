import type { Campaign } from "@/lib/types/campaign";
import type { EmailContent } from "@/lib/types/email";
import {
  renderMergeVars,
  toMailchimpMergeTags,
  type MergeContext,
} from "@/lib/email/mergeVars";

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
    if (/[A-Z]{6,}/.test(content.subject)) w.push("subject_shouting");
    if ((content.subject.match(/!/g)?.length ?? 0) > 1) {
      w.push("subject_excess_exclamation");
    }
  }
  return w;
}

// ---- HTML assembly --------------------------------------------------------

function looksHtml(body: string): boolean {
  return /<\w+[\s/>]/.test(body);
}

/** Wrap already-escaped plain text into paragraphs (does NOT escape). */
function paragraphize(escaped: string): string {
  return escaped
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

function bodyToHtml(body: string): string {
  // Broadcast path: MailChimp merge TAGS, no subscriber-controlled values here.
  return looksHtml(body) ? body : paragraphize(escapeHtml(body));
}

function wrap(inner: string, heroImageUrl: string | null): string {
  const hero = heroImageUrl
    ? `<img src="${heroImageUrl}" alt="" style="display:block;width:100%;max-width:560px;border-radius:12px;margin:0 0 20px"/>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#f6f6f6">
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111;background:#fff">
    ${hero}
    ${inner}
  </div>
</body></html>`;
}

function htmlToText(html: string): string {
  return html
    .replace(/<\/(p|div|h\d|li)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
