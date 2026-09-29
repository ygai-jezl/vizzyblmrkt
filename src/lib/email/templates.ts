import type { EmailMessage } from "./index";
import { getMessage } from "@/lib/i18n/messages";
import { localeInfo } from "@/lib/i18n/locale";
import { OPENING_WORDS_MAX, wrap } from "./emailRender";
import { accentFor, readableOn, type ResolvedEmailStyle } from "./emailStyle";
import { fontFor } from "./emailFonts";
import { themeTokens } from "./emailThemes";

/**
 * Double opt-in verification email. Copy comes from the locale message catalog
 * (English base; localizes per-locale as translations land). `{{merge_tokens}}`
 * are not used here — the few dynamic bits (brand name, first name, link) are
 * interpolated directly. `locale` is the visitor's resolved signup language.
 *
 * With a `style` (the tenant's Email style: resolveTransactionalEmailStyle) the same copy goes
 * through wrap(): the colour header, the card and theme, and the button in the button colour
 * with a readable label. Subject and text are the same either way; with no style the HTML is
 * today's literal. Pure + client-safe, so the Email style page can preview it.
 */
export function verificationEmail(opts: {
  to: string;
  waitlistName: string;
  verifyUrl: string;
  firstName?: string | null;
  locale?: string | null;
  style?: ResolvedEmailStyle | null;
}): EmailMessage {
  const { locale } = opts;
  const info = localeInfo(locale);
  const name = escapeHtml(opts.waitlistName);
  // Greeting differs by channel: HTML escapes the name, plain text does not.
  const greetingHtml = opts.firstName
    ? getMessage(locale, "email.verify.greetingNamed", { name: escapeHtml(opts.firstName) })
    : getMessage(locale, "email.verify.greetingPlain");
  const greetingText = opts.firstName
    ? getMessage(locale, "email.verify.greetingNamed", { name: opts.firstName })
    : getMessage(locale, "email.verify.greetingPlain");
  const subject = getMessage(locale, "email.verify.subject", { name: opts.waitlistName });
  const text = `${greetingText}\n\n${getMessage(locale, "email.verify.bodyText", { name: opts.waitlistName })}\n${opts.verifyUrl}\n\n${getMessage(locale, "email.verify.footer")}`;
  if (opts.style) {
    const url = escapeHtml(opts.verifyUrl);
    const inner = [
      `<p>${greetingHtml}</p>`,
      `<p>${getMessage(locale, "email.verify.bodyHtml", { name: `<strong>${name}</strong>` })}</p>`,
      styledButton(opts.verifyUrl, getMessage(locale, "email.verify.button"), opts.style),
      `<p style="color:#666;font-size:13px;word-wrap:break-word">${getMessage(locale, "email.verify.pasteLink")}<br>${url}</p>`,
      `<p style="color:#999;font-size:12px;margin-top:28px">${getMessage(locale, "email.verify.footer")}</p>`,
    ].join("\n    ");
    // The inbox preview repeats the opening lines, so it never says anything the email doesn't.
    const preheader = preheaderFrom(
      `${greetingText} ${getMessage(locale, "email.verify.bodyHtml", { name: opts.waitlistName })}`,
    );
    return {
      to: opts.to,
      subject,
      text,
      html: wrap(inner, null, { style: opts.style, preheader, lang: info.code, dir: info.dir }),
    };
  }
  return {
    to: opts.to,
    subject,
    text,
    html: `<!doctype html><html lang="${info.code}" dir="${info.dir}"><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">
  <p>${greetingHtml}</p>
  <p>${getMessage(locale, "email.verify.bodyHtml", { name: `<strong>${name}</strong>` })}</p>
  <p style="margin:28px 0">
    <a href="${opts.verifyUrl}" style="background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block">${getMessage(locale, "email.verify.button")}</a>
  </p>
  <p style="color:#666;font-size:13px">${getMessage(locale, "email.verify.pasteLink")}<br>${opts.verifyUrl}</p>
  <p style="color:#999;font-size:12px;margin-top:28px">${getMessage(locale, "email.verify.footer")}</p>
</body></html>`,
  };
}

/**
 * Default offboarding copy (merge-token strings), used when an admin enables the
 * offboarding email but leaves the subject/body blank. Rendered through
 * renderMergeVars at send time. Locale-aware variants for the send path are
 * `defaultOffboardingSubject/Body`; these English consts remain for callers/tests.
 */
export const DEFAULT_OFFBOARDING_SUBJECT = getMessage("en", "email.offboard.subject");
export const DEFAULT_OFFBOARDING_BODY = getMessage("en", "email.offboard.body");

/** Localized default offboarding subject (English base until translated). */
export function defaultOffboardingSubject(locale?: string | null): string {
  return getMessage(locale, "email.offboard.subject");
}
/** Localized default offboarding body (English base until translated). */
export function defaultOffboardingBody(locale?: string | null): string {
  return getMessage(locale, "email.offboard.body");
}

/**
 * Offboarding lifecycle email. Takes the FINAL (already merge-rendered) subject
 * and body; the body is treated as plain text — escaped and newline-wrapped into
 * a simple branded HTML shell (no admin-authored HTML, so nothing to inject).
 * `locale` only sets the shell's lang/dir (the copy is already rendered).
 *
 * With a `style` the same body goes through wrap() (the colour header, the card and theme);
 * subject and text are unchanged, and with no style the HTML is today's literal.
 */
export function offboardingEmail(opts: {
  to: string;
  subject: string;
  body: string;
  locale?: string | null;
  style?: ResolvedEmailStyle | null;
}): EmailMessage {
  const info = localeInfo(opts.locale);
  const safeBody = escapeHtml(opts.body).replace(/\n/g, "<br>");
  if (opts.style) {
    return {
      to: opts.to,
      subject: opts.subject,
      text: opts.body,
      html: wrap(`<div>${safeBody}</div>`, null, {
        style: opts.style,
        preheader: preheaderFrom(opts.body),
        lang: info.code,
        dir: info.dir,
      }),
    };
  }
  return {
    to: opts.to,
    subject: opts.subject,
    text: opts.body,
    html: `<!doctype html><html lang="${info.code}" dir="${info.dir}"><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">
  <div>${safeBody}</div>
</body></html>`,
  };
}

/**
 * A styled email's one button: a table cell in the button colour (bgcolor too, for Outlook) with
 * a black or white label, whichever reads, and the theme's button shape (none = today's 8px).
 * The link is the plain email's, escaped, with nothing added to it.
 */
function styledButton(href: string, label: string, style: ResolvedEmailStyle): string {
  const bg = accentFor(style, "button") ?? "#111111";
  const radius = themeTokens(style)?.buttonRadius ?? 8;
  return `<div style="margin:28px 0"><table role="presentation" cellpadding="0" cellspacing="0" style="display:inline-block;border-collapse:separate"><tr><td bgcolor="${bg}" style="background:${bg};border-radius:${radius}px"><a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:12px 24px;font-family:${fontFor(style, "body")};font-size:15px;font-weight:600;color:${readableOn(bg)};text-decoration:none">${label}</a></td></tr></table></div>`;
}

/** Plain copy as an inbox preview: one line, as much as an inbox shows, never half an emoji. */
function preheaderFrom(copy: string): string {
  return copy
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, OPENING_WORDS_MAX)
    .replace(/[\uD800-\uDBFF]$/, "")
    .trimEnd();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
