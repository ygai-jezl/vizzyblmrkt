import type { EmailMessage } from "./index";
import { getMessage } from "@/lib/i18n/messages";
import { localeInfo } from "@/lib/i18n/locale";

/**
 * Double opt-in verification email. Copy comes from the locale message catalog
 * (English base; localizes per-locale as translations land). `{{merge_tokens}}`
 * are not used here — the few dynamic bits (brand name, first name, link) are
 * interpolated directly. `locale` is the visitor's resolved signup language.
 */
export function verificationEmail(opts: {
  to: string;
  waitlistName: string;
  verifyUrl: string;
  firstName?: string | null;
  locale?: string | null;
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
  return {
    to: opts.to,
    subject: getMessage(locale, "email.verify.subject", { name: opts.waitlistName }),
    text: `${greetingText}\n\n${getMessage(locale, "email.verify.bodyText", { name: opts.waitlistName })}\n${opts.verifyUrl}\n\n${getMessage(locale, "email.verify.footer")}`,
    html: `<!doctype html><html lang="${info.code}" dir="${info.dir}"><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">
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
 */
export function offboardingEmail(opts: {
  to: string;
  subject: string;
  body: string;
  locale?: string | null;
}): EmailMessage {
  const info = localeInfo(opts.locale);
  const safeBody = escapeHtml(opts.body).replace(/\n/g, "<br>");
  return {
    to: opts.to,
    subject: opts.subject,
    text: opts.body,
    html: `<!doctype html><html lang="${info.code}" dir="${info.dir}"><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">
  <div>${safeBody}</div>
</body></html>`,
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
