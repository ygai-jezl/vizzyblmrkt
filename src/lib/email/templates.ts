import type { EmailMessage } from "./index";

/** Double opt-in verification email. */
export function verificationEmail(opts: {
  to: string;
  waitlistName: string;
  verifyUrl: string;
  firstName?: string | null;
}): EmailMessage {
  const greeting = opts.firstName ? `Hi ${escapeHtml(opts.firstName)},` : "Hi,";
  const name = escapeHtml(opts.waitlistName);
  return {
    to: opts.to,
    subject: `Confirm your spot on the ${opts.waitlistName} waitlist`,
    text: `${opts.firstName ? `Hi ${opts.firstName},` : "Hi,"}\n\nConfirm your email to lock in your place on the ${opts.waitlistName} waitlist:\n${opts.verifyUrl}\n\nIf you didn't sign up, you can ignore this email.`,
    html: `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">
  <p>${greeting}</p>
  <p>Confirm your email to lock in your place on the <strong>${name}</strong> waitlist.</p>
  <p style="margin:28px 0">
    <a href="${opts.verifyUrl}" style="background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block">Confirm my spot</a>
  </p>
  <p style="color:#666;font-size:13px">Or paste this link into your browser:<br>${opts.verifyUrl}</p>
  <p style="color:#999;font-size:12px;margin-top:28px">If you didn't sign up, you can ignore this email.</p>
</body></html>`,
  };
}

/**
 * Default offboarding copy (merge-token strings). Used when an admin enables the
 * offboarding email but leaves the subject/body blank. Rendered through
 * renderMergeVars at send time (see processLifecycleJob), so the tokens resolve
 * per-recipient. Kept as plain text — the offboarding email is intentionally
 * simple (body is escaped + newline-wrapped into HTML by offboardingEmail).
 */
export const DEFAULT_OFFBOARDING_SUBJECT =
  "You're off the waitlist for {{waitlist_name}} 🎉";
export const DEFAULT_OFFBOARDING_BODY =
  "Hi {{first_name}},\n\n" +
  "Great news — you've been moved off the {{waitlist_name}} waitlist and now have access.\n\n" +
  "Thanks for being an early supporter!";

/**
 * Offboarding lifecycle email. Takes the FINAL (already merge-rendered) subject
 * and body; the body is treated as plain text — escaped and newline-wrapped into
 * a simple branded HTML shell (no admin-authored HTML, so nothing to inject).
 */
export function offboardingEmail(opts: {
  to: string;
  subject: string;
  body: string;
}): EmailMessage {
  const safeBody = escapeHtml(opts.body).replace(/\n/g, "<br>");
  return {
    to: opts.to,
    subject: opts.subject,
    text: opts.body,
    html: `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">
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
