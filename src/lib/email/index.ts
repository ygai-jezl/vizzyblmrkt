/**
 * Minimal transactional email abstraction. Uses Resend when RESEND_API_KEY is
 * set; otherwise logs the message (so the double opt-in flow works end-to-end in
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
}

export interface EmailResult {
  sent: boolean;
  provider: "resend" | "log";
  id?: string;
  reason?: string;
}

const DEFAULT_FROM = "Vizzybl <onboarding@resend.dev>";

export async function sendEmail(msg: EmailMessage): Promise<EmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (apiKey) return sendViaResend(msg, apiKey);
  return logEmail(msg);
}

async function sendViaResend(
  msg: EmailMessage,
  apiKey: string,
): Promise<EmailResult> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM ?? DEFAULT_FROM,
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
