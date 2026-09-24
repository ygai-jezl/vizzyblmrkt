import { compileJourneyEmail } from "@/lib/agents/compiler";
import { escapeHtml, looksHtml } from "@/lib/email/emailRender";
import type { MergeContext } from "@/lib/email/mergeVars";
import { getMessage } from "@/lib/i18n/messages";

/**
 * The invite email (nav v2 phase 4). Rendered exactly like a journey email — the
 * same merge tags, hero image, mandatory footer and HTML escaping — plus three
 * invite tags the author can place anywhere:
 *
 *   {{invite_link}}          → a button in HTML, the bare URL in plain text
 *   {{product_name}}         → the product's name (without "(production)")
 *   {{invite_expires_days}}  → how many days the link works
 *
 * Unknown tags render blank in the journey compiler, so invite tags are swapped
 * for inert placeholders first and replaced in the finished HTML and text.
 */

const INVITE_TAG_RE = /\{\{\s*(invite_link|product_name|invite_expires_days)\s*\}\}/g;
const LINK_TAG_RE = /\{\{\s*invite_link\s*\}\}/;
const PLACEHOLDER = {
  invite_link: "YGINV1LINKPH",
  product_name: "YGINV1PRODUCTPH",
  invite_expires_days: "YGINV1DAYSPH",
} as const;
type InviteTag = keyof typeof PLACEHOLDER;

export const INVITE_TAGS: readonly InviteTag[] = ["invite_link", "product_name", "invite_expires_days"];

export function hasInviteLink(body: string): boolean {
  return LINK_TAG_RE.test(body);
}

/** Every invite must carry its link: append it as its own paragraph when the author left it out. */
export function ensureInviteLink(body: string): string {
  if (hasInviteLink(body)) return body;
  return looksHtml(body) ? `${body}\n<p>{{invite_link}}</p>` : `${body.trimEnd()}\n\n{{invite_link}}`;
}

/** The starting copy for a new wave, in the launch's language (English until translated). */
export function defaultInviteCopy(locale?: string | null): { subject: string; body: string } {
  return { subject: getMessage(locale, "email.invite.subject"), body: getMessage(locale, "email.invite.body") };
}

export interface RenderInviteInput {
  subject: string;
  body: string;
  heroImageUrl?: string | null;
  merge: MergeContext;
  inviteUrl: string;
  productName: string;
  expiresInDays: number;
  locale?: string | null;
}

function fill(s: string, values: Record<InviteTag, string>): string {
  let out = s;
  for (const tag of INVITE_TAGS) out = out.split(PLACEHOLDER[tag]).join(values[tag]);
  return out;
}

export function renderInviteEmail(input: RenderInviteInput): { subject: string; html: string; text: string } {
  const toPlaceholders = (s: string) => s.replace(INVITE_TAG_RE, (_m, tag: InviteTag) => PLACEHOLDER[tag]);
  const compiled = compileJourneyEmail(
    {
      subject: toPlaceholders(input.subject),
      body: toPlaceholders(ensureInviteLink(input.body)),
      heroImageUrl: input.heroImageUrl ?? null,
    },
    input.merge,
  );
  const days = String(input.expiresInDays);
  const cta = getMessage(input.locale, "email.invite.cta").replace(/\{\{\s*product_name\s*\}\}/g, input.productName);
  const button =
    `<a href="${escapeHtml(input.inviteUrl)}" target="_blank" rel="noopener noreferrer" ` +
    `style="background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block;font-weight:600">` +
    `${escapeHtml(cta)}</a>`;
  return {
    // Plain text; strip CR/LF so no value can smuggle in an extra header.
    subject: fill(compiled.subject, { invite_link: "", product_name: input.productName, invite_expires_days: days })
      .replace(/[\r\n]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim(),
    html: fill(compiled.html, { invite_link: button, product_name: escapeHtml(input.productName), invite_expires_days: days }),
    text: fill(compiled.text ?? "", { invite_link: input.inviteUrl, product_name: input.productName, invite_expires_days: days }),
  };
}
