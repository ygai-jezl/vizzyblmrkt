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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
