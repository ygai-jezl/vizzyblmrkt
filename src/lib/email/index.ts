/**
 * Minimal transactional email abstraction. Provider precedence: MailChimp
 * Transactional (Mandrill) when MANDRILL_API_KEY is set, else Resend when
 * RESEND_API_KEY is set; otherwise logs the message (so the double opt-in flow
 * works end-to-end in
 * dev / before a provider is configured — the verification link still gets
 * generated and is visible in logs). Swap in SendGrid/SES/SMTP behind the same
 * interface later.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  /**
   * Optional sender overrides for custom-domain sending (resolved from the
   * tenant/campaign config — see src/lib/email/sender.ts). Each falls back to the
   * env-configured EMAIL_FROM when undefined.
   */
  fromEmail?: string;
  fromName?: string;
}

export interface EmailResult {
  sent: boolean;
  provider: "mandrill" | "resend" | "log";
  id?: string;
  reason?: string;
}

const DEFAULT_FROM = "YouGrow.ai <onboarding@resend.dev>";

export async function sendEmail(msg: EmailMessage): Promise<EmailResult> {
  const mandrillKey = process.env.MANDRILL_API_KEY;
  if (mandrillKey) return sendViaMandrill(msg, mandrillKey);
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) return sendViaResend(msg, resendKey);
  return logEmail(msg);
}

/**
 * MailChimp Transactional (Mandrill). Mandrill needs the from-address split into
 * email + display name, so we parse EMAIL_FROM ("Name <addr>" or bare "addr").
 */
async function sendViaMandrill(
  msg: EmailMessage,
  apiKey: string,
): Promise<EmailResult> {
  const parsed = parseFrom(process.env.EMAIL_FROM ?? DEFAULT_FROM);
  const fromEmail = msg.fromEmail?.trim() || parsed.email;
  const fromName = msg.fromName?.trim() || parsed.name;
  try {
    const res = await fetch("https://mandrillapp.com/api/1.0/messages/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: apiKey,
        message: {
          subject: msg.subject,
          html: msg.html,
          ...(msg.text ? { text: msg.text } : {}),
          from_email: fromEmail,
          ...(fromName ? { from_name: fromName } : {}),
          to: [{ email: msg.to, type: "to" }],
          ...(msg.replyTo ? { headers: { "Reply-To": msg.replyTo } } : {}),
        },
      }),
    });
    if (!res.ok) {
      return { sent: false, provider: "mandrill", reason: `http_${res.status}` };
    }
    // Mandrill returns an array of per-recipient send results.
    const data = (await res.json().catch(() => [])) as Array<{
      status?: string;
      _id?: string;
      reject_reason?: string;
    }>;
    const first = Array.isArray(data) ? data[0] : undefined;
    const accepted =
      first?.status === "sent" ||
      first?.status === "queued" ||
      first?.status === "scheduled";
    if (!accepted) {
      return {
        sent: false,
        provider: "mandrill",
        reason: first?.reject_reason ?? first?.status ?? "rejected",
      };
    }
    return { sent: true, provider: "mandrill", id: first?._id };
  } catch {
    return { sent: false, provider: "mandrill", reason: "request_error" };
  }
}

/** Split an RFC5322-ish "Name <addr>" (or a bare "addr") into parts. */
function parseFrom(from: string): { email: string; name?: string } {
  const m = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1] || undefined, email: m[2]!.trim() };
  return { email: from.trim() };
}

async function sendViaResend(
  msg: EmailMessage,
  apiKey: string,
): Promise<EmailResult> {
  const parsed = parseFrom(process.env.EMAIL_FROM ?? DEFAULT_FROM);
  const fromEmail = msg.fromEmail?.trim() || parsed.email;
  const fromName = msg.fromName?.trim() || parsed.name;
  const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [msg.to],
        subject: msg.subject,
        html: msg.html,
        ...(msg.text ? { text: msg.text } : {}),
        ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
      }),
    });
    if (!res.ok) {
      return { sent: false, provider: "resend", reason: `http_${res.status}` };
    }
    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { sent: true, provider: "resend", id: data.id };
  } catch {
    return { sent: false, provider: "resend", reason: "request_error" };
  }
}

function logEmail(msg: EmailMessage): EmailResult {
  console.log(
    `[email:log] to=${msg.to} subject="${msg.subject}" (no RESEND_API_KEY — not sent)\n${msg.text ?? msg.html}`,
  );
  return { sent: false, provider: "log" };
}
