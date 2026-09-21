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
  /**
   * Provider-side engagement tracking (Mandrill only). A flag that is set is sent
   * EXPLICITLY, so `false` really turns tracking off; an unset flag falls back to
   * the Mandrill account default. Turning it on lets Mandrill record opens/clicks
   * and POST them to our webhook.
   */
  track?: { opens?: boolean; clicks?: boolean };
  /**
   * Per-message metadata echoed back verbatim on Mandrill open/click/send
   * webhooks (as `msg.metadata`). This is how an inbound event is attributed to
   * a journey step + recipient + A/B arm with NO database lookup. Flat
   * string→string map. Resend/log providers ignore it.
   */
  metadata?: Record<string, string>;
  /** Mandrill tags (each ≤50 chars and must not start with "_"). */
  tags?: string[];
  /**
   * One-click unsubscribe (RFC 2369 / 8058). Emits `List-Unsubscribe: <url>` and,
   * when `oneClick`, `List-Unsubscribe-Post: List-Unsubscribe=One-Click` so inbox
   * providers show a native Unsubscribe button that POSTs to the URL. Mandrill
   * only (folded into message.headers); Resend/log ignore it.
   */
  listUnsubscribe?: { url: string; oneClick?: boolean };
  /** Mandrill subaccount to send through (per-tenant reputation isolation). */
  subaccount?: string;
  /**
   * Extra SMTP headers (Mandrill only), e.g. `Feedback-ID`. Names must be plain
   * header tokens and values single-line; anything else is dropped, never sent.
   * Reply-To and List-Unsubscribe come from their own fields and can't be
   * overridden here.
   */
  headers?: Record<string, string>;
}

export interface EmailResult {
  sent: boolean;
  provider: "mandrill" | "resend" | "log";
  id?: string;
  reason?: string;
  /**
   * The provider MAY have accepted the message, but we can't tell: a timeout, a
   * dropped connection, a 5xx with no readable error body, or a 2xx we couldn't
   * read. Callers must NEVER resend an ambiguous message — treat it as sent
   * (at-most-once beats a duplicate email) and record the ambiguity. Only ever
   * set when `sent` is false.
   */
  ambiguous?: boolean;
}

const DEFAULT_FROM = "YouGrow.ai <onboarding@resend.dev>";
/** Hard cap on one provider request, so a hung connection can't stall a drain. */
const SEND_TIMEOUT_MS = 20_000;

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
  // Custom SMTP headers (caller extras, Reply-To, one-click List-Unsubscribe),
  // sent only when set. The reserved headers are applied last so they always win.
  const headers: Record<string, string> = safeExtraHeaders(msg.headers);
  if (msg.replyTo) headers["Reply-To"] = msg.replyTo;
  if (msg.listUnsubscribe?.url) {
    headers["List-Unsubscribe"] = `<${msg.listUnsubscribe.url}>`;
    if (msg.listUnsubscribe.oneClick) {
      headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
    }
  }
  let res: Response;
  try {
    res = await fetch("https://mandrillapp.com/api/1.0/messages/send", {
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
          ...(Object.keys(headers).length ? { headers } : {}),
          ...(typeof msg.track?.opens === "boolean" ? { track_opens: msg.track.opens } : {}),
          ...(typeof msg.track?.clicks === "boolean" ? { track_clicks: msg.track.clicks } : {}),
          ...(msg.subaccount ? { subaccount: msg.subaccount } : {}),
          ...(msg.metadata ? { metadata: msg.metadata } : {}),
          ...(msg.tags && msg.tags.length ? { tags: msg.tags } : {}),
        },
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (err) {
    // Timed out, or the connection dropped: the request may already have
    // reached Mandrill, so the outcome is unknown.
    return {
      sent: false,
      provider: "mandrill",
      reason: isTimeout(err) ? "timeout" : "request_error",
      ambiguous: true,
    };
  }
  if (!res.ok) return httpFailure("mandrill", res);
  // Mandrill returns an array of per-recipient send results.
  const data = (await res.json().catch(() => undefined)) as
    | Array<{ status?: string; _id?: string; reject_reason?: string }>
    | undefined;
  const first = Array.isArray(data) ? data[0] : undefined;
  if (!first || typeof first !== "object") {
    // A 2xx whose per-recipient result we can't read: Mandrill most likely
    // accepted the message, so this must never be resent.
    return { sent: false, provider: "mandrill", reason: "unreadable_response", ambiguous: true };
  }
  const accepted =
    first.status === "sent" ||
    first.status === "queued" ||
    first.status === "scheduled";
  if (!accepted) {
    return {
      sent: false,
      provider: "mandrill",
      reason: first.reject_reason ?? first.status ?? "rejected",
    };
  }
  return { sent: true, provider: "mandrill", id: first._id };
}

/**
 * A non-2xx response. A 4xx, or a 5xx carrying the provider's JSON error, is a
 * definite not-sent (safe to retry). A 5xx with no readable body can't be told
 * apart from "accepted, then the response was lost", so it is ambiguous.
 */
async function httpFailure(
  provider: "mandrill" | "resend",
  res: Response,
): Promise<EmailResult> {
  const reason = `http_${res.status}`;
  if (res.status < 500) return { sent: false, provider, reason };
  const body = await res.text().catch(() => "");
  return isJsonObject(body)
    ? { sent: false, provider, reason }
    : { sent: false, provider, reason, ambiguous: true };
}

function isJsonObject(text: string): boolean {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null;
  } catch {
    return false;
  }
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

/** Plain header tokens only (no spaces, colons or control characters). */
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
/** Set from their own EmailMessage fields; extras can't override them. */
const RESERVED_HEADERS = new Set(["reply-to", "list-unsubscribe", "list-unsubscribe-post"]);

/** Keep only well-formed, single-line extra headers (no header injection). */
function safeExtraHeaders(extra?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(extra ?? {})) {
    if (!HEADER_NAME_RE.test(name) || RESERVED_HEADERS.has(name.toLowerCase())) continue;
    if (typeof value !== "string" || /[\r\n]/.test(value) || value.length > 998) continue;
    out[name] = value;
  }
  return out;
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
  let res: Response;
  try {
    res = await fetch("https://api.resend.com/emails", {
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
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (err) {
    // Timed out, or the connection dropped: the outcome is unknown.
    return {
      sent: false,
      provider: "resend",
      reason: isTimeout(err) ? "timeout" : "request_error",
      ambiguous: true,
    };
  }
  if (!res.ok) return httpFailure("resend", res);
  const data = (await res.json().catch(() => ({}))) as { id?: string };
  return { sent: true, provider: "resend", id: data.id };
}

function logEmail(msg: EmailMessage): EmailResult {
  console.log(
    `[email:log] to=${msg.to} subject="${msg.subject}" (no RESEND_API_KEY — not sent)\n${msg.text ?? msg.html}`,
  );
  return { sent: false, provider: "log" };
}
