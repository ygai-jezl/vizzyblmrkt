import { createHash, randomBytes, randomInt } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import type { Auth, DecodedIdToken, UserRecord } from "firebase-admin/auth";
import { sendEmail, type EmailMessage, type EmailResult } from "@/lib/email";
import { platformOrigin } from "@/lib/platform/origin";
import {
  checkEmailCode,
  checkEmailLink,
  claimEmailCodeSend,
  deleteEmailCode,
  deleteEmailLink,
  EMAIL_CODE_VALID_MS,
  EMAIL_LINK_VALID_MS,
  isRateLimited,
  putEmailCode,
  putEmailLink,
  type RateLimitConfig,
} from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { adminAuth } from "./adminAuth";
import { isListedAdminEmail } from "./allowlist";
import { isSelfServeSignupOpen } from "./flags";
import { EMAIL_CODE_EMAIL, EMAIL_LINK_EMAIL } from "./messages";

/**
 * The emailed 6-digit code that confirms a password account's address (PASSWORD_SIGNIN_ENABLED,
 * rule 3 of the password sign-in plan). POST /api/auth/email-code sends one; PUT checks it.
 *
 * - The caller proves who they are with a Firebase ID token, checked for revocation, from a
 *   password sign-in. A Google account never needs a code.
 * - Sending: rate limited per visitor, per account and per address, and capped per address in
 *   the database (6 an hour, none after 15 wrong tries in a day: src/lib/tenant/emailCodes.ts).
 *   That cap fails closed, unlike the shared rate limiter. A code is made and stored (hashed)
 *   for every caller, but emailed only when the address may get in: exactly on
 *   ADMIN_ALLOWED_EMAILS, or anyone once self-serve sign-up is open. The answer is the same
 *   either way, and every answer waits for the same SEND_FLOOR_MS while the email goes out
 *   inside the request (Cloud Run can pause work left running after a response), so neither
 *   the answer, a later check nor the time taken says whether an address is on the list.
 * - Checking: right, the account gets the `email_code` custom claim (the marker the door looks
 *   for, merged into its other claims), then emailVerified, and the code is deleted. Wrong
 *   counts down from 5 tries per code, and every wrong try counts against the address for a
 *   day. Codes last 10 minutes (src/lib/tenant/emailCodes.ts).
 * - Locked: after 15 wrong tries in a day the address gets code_locked, to a send and to a
 *   check, and the wrong try that locks it is logged once as auth_code_locked (the domain only).
 * - The link ("Email me a link instead", POST with via "link"): anyone can trip the lock for an
 *   address they made an account for, so a link to the same inbox takes the code's place. It
 *   passes the same gate and limits as a code, and counts toward the address's 6 sends an hour,
 *   but the lock doesn't stop it: 32 random bytes can't be guessed. It is stored hashed with the
 *   account's uid and address, works once for 30 minutes, and only for that account: PUT with
 *   `link` from a browser signed in to it. The URL is built on platformOrigin(), never on a
 *   request header, and carries the token after the #, so it never reaches a server log, a
 *   proxy or a Referer header. No platform origin, no link: 503 link_unavailable.
 * - The emails hold the code or the link and fixed words only: nothing the account holder typed.
 *   Logs hold the address's domain at most, never the address, the code or the link.
 */

/** The custom claim that says the account confirmed its address with an emailed code. */
export const EMAIL_CODE_CLAIM = "email_code";
/** Seconds the code screen waits before it offers to send another code. */
export const RESEND_AFTER_SECONDS = 30;
/**
 * How long every send answer takes, emailed or not: long enough for the email provider to take
 * the message inside the request, and the same for every caller so the time says nothing.
 */
export const SEND_FLOOR_MS = 2_000;

/** Rate limits (src/lib/tenant/rateLimit.ts), each per minute and per hour. */
export const EMAIL_CODE_LIMITS = {
  /** Sends per visitor address. */
  ip: { prefix: "auth-code-ip", burstLimit: 5, hourlyLimit: 20 },
  /** Sends per account. */
  uid: { prefix: "auth-code-uid", burstLimit: 2, hourlyLimit: 6 },
  /** Sends per email address, keyed by its hash. */
  to: { prefix: "auth-code-to", burstLimit: 2, hourlyLimit: 6 },
  /** Checks per visitor address. */
  checkIp: { prefix: "auth-code-check-ip", burstLimit: 10, hourlyLimit: 60 },
  /** Link checks per visitor address (links need no count of wrong tries; this only slows a flood). */
  linkCheckIp: { prefix: "auth-link-check-ip", burstLimit: 10, hourlyLimit: 60 },
} as const satisfies Record<string, RateLimitConfig>;

const CODE_RE = /^\d{6}$/;
const VALID_MINUTES = EMAIL_CODE_VALID_MS / 60_000;
const LINK_VALID_MINUTES = EMAIL_LINK_VALID_MS / 60_000;

/** Random bytes in a link's token (base64url, 43 characters). */
export const LINK_TOKEN_BYTES = 32;
/** What PUT accepts as a link's token: base64url, 20 to 100 characters. */
export const LINK_TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/;
/** The page the link opens (src/app/login/confirm/page.tsx). */
export const CONFIRM_PATH = "/login/confirm";

/** The Firebase Auth calls this file makes (the real Auth, or a test's fake). */
export type EmailCodeAuth = Pick<Auth, "verifyIdToken" | "getUser" | "updateUser" | "setCustomUserClaims">;

export interface EmailCodeDeps {
  auth?: EmailCodeAuth;
  db?: FirestoreLike;
  send?: (msg: EmailMessage) => Promise<EmailResult>;
  /** Waits this many milliseconds (a test's fake, or a real timer). */
  sleep?: (ms: number) => Promise<unknown>;
  now?: Date;
}

/** What the route answers: an HTTP status and a JSON body. */
export interface EmailCodeAnswer {
  status: number;
  body: Record<string, unknown>;
}

export type PasswordCaller =
  | { ok: true; uid: string; email: string; user: UserRecord }
  | { ok: false; error: "invalid_id_token" | "not_a_password_account" };

const RATE_LIMITED: EmailCodeAnswer = { status: 429, body: { error: "rate_limited" } };
const CODE_LOCKED_SEND: EmailCodeAnswer = { status: 429, body: { error: "code_locked" } };
const LINK_UNAVAILABLE: EmailCodeAnswer = { status: 503, body: { error: "link_unavailable" } };
const LINK_INVALID: EmailCodeAnswer = { status: 400, body: { error: "link_invalid" } };

// --- Who is asking ----------------------------------------------------------------------------

/**
 * Verify the caller's ID token (revoked or disabled accounts fail) and that it comes from a
 * password sign-in on an account that has an address. The address used from here on is the
 * account's own, read fresh, not the token's copy.
 */
export async function verifyPasswordCaller(idToken: string, auth: EmailCodeAuth = adminAuth()): Promise<PasswordCaller> {
  let decoded: DecodedIdToken;
  try {
    decoded = await auth.verifyIdToken(idToken, true);
  } catch {
    return { ok: false, error: "invalid_id_token" };
  }
  if (decoded.firebase?.sign_in_provider !== "password") return { ok: false, error: "not_a_password_account" };
  let user: UserRecord;
  try {
    user = await auth.getUser(decoded.uid);
  } catch {
    return { ok: false, error: "invalid_id_token" };
  }
  const email = user.email?.trim();
  if (!email || !user.providerData.some((p) => p.providerId === "password")) {
    return { ok: false, error: "not_a_password_account" };
  }
  return { ok: true, uid: decoded.uid, email, user };
}

/** The account already confirmed its address with a code. */
export function isEmailConfirmed(user: Pick<UserRecord, "emailVerified" | "customClaims">): boolean {
  return user.emailVerified === true && user.customClaims?.[EMAIL_CODE_CLAIM] === true;
}

/**
 * Whether an account with this address could get in once confirmed, so a code is worth sending:
 * its exact address is on ADMIN_ALLOWED_EMAILS (any case), or self-serve sign-up is open. The
 * domain list doesn't count: it is for Google sign-in only.
 */
export function mayGetIn(email: string): boolean {
  return isSelfServeSignupOpen() || isListedAdminEmail(email);
}

// --- The code ---------------------------------------------------------------------------------

/** A fresh 6-digit code, zero padded. */
export function newEmailCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/** What is stored for a code: SHA-256 of `uid:address in lower case:code`, in hex. */
export function hashEmailCode(uid: string, email: string, code: string): string {
  return createHash("sha256").update(`${uid}:${email.trim().toLowerCase()}:${code}`).digest("hex");
}

/** The rate limit key for an address: its hash, never the address. */
function addressKey(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

/** The part after the @, for logs. */
function domainOf(email: string): string {
  return email.split("@").pop()?.toLowerCase() || "unknown";
}

/**
 * The moment an address is first shut out of codes: one structured WARNING line (Cloud Logging
 * reads a JSON line as jsonPayload, so an alert can match jsonPayload.event). It means someone is
 * typing wrong codes for the address. The domain only, never the address.
 */
function logCodeLocked(email: string): void {
  console.warn(
    JSON.stringify({
      severity: "WARNING",
      message: "[auth] auth_code_locked",
      event: "auth_code_locked",
      emailDomain: domainOf(email),
    }),
  );
}

// --- The link ---------------------------------------------------------------------------------

/** A fresh link token: 32 random bytes, base64url. */
export function newEmailLinkToken(): string {
  return randomBytes(LINK_TOKEN_BYTES).toString("base64url");
}

/** What is stored for a link: SHA-256 of `link:uid:address in lower case:token`, in hex. */
export function hashEmailLink(uid: string, email: string, token: string): string {
  return createHash("sha256").update(`link:${uid}:${email.trim().toLowerCase()}:${token}`).digest("hex");
}

/** The platform's own origin for links (scheme and host only), or null when none is set or it isn't http(s). */
function linkOrigin(): string | null {
  const raw = platformOrigin();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * The link's URL: platformOrigin() (NEXT_PUBLIC_PLATFORM_ORIGIN), never a request header, so a
 * forged Host can't point the email elsewhere. The token goes after the #, which browsers never
 * send to a server. Null when no platform origin is set.
 */
export function confirmLinkUrl(token: string): string | null {
  if (!LINK_TOKEN_RE.test(token)) throw new Error("confirmLinkUrl: the token must be base64url");
  const origin = linkOrigin();
  return origin ? `${origin}${CONFIRM_PATH}#t=${token}` : null;
}

const CONFIRM_URL_RE = /^https?:\/\/[^\s"'<>#]+\/login\/confirm#t=[A-Za-z0-9_-]{20,100}$/;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** The link email. Only the link and fixed words go in it. */
export function emailLinkMessage(to: string, url: string): EmailMessage {
  if (!CONFIRM_URL_RE.test(url)) throw new Error("emailLinkMessage: not a confirm link");
  const e = EMAIL_LINK_EMAIL;
  const use = e.use(LINK_VALID_MINUTES);
  const href = escapeHtml(url);
  const text = `${e.textIntro}\n\n${url}\n\n${use}\n\n${e.ignore}\n`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${e.title}</title></head><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">
  <p>${e.intro}</p>
  <p style="margin:24px 0"><a href="${href}" rel="noreferrer" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:600">${e.button}</a></p>
  <p style="color:#444;font-size:13px">${e.plain}<br><span style="word-break:break-all">${href}</span></p>
  <p>${use}</p>
  <p style="color:#666;font-size:13px;margin-top:28px">${e.ignore}</p>
</body></html>`;
  return {
    to,
    subject: e.subject,
    text,
    html,
    track: { opens: false, clicks: false },
    tags: ["auth-link"],
  };
}

/** The email. Only the code and fixed words go in it. */
export function emailCodeMessage(to: string, code: string): EmailMessage {
  if (!CODE_RE.test(code)) throw new Error("emailCodeMessage: the code must be 6 digits");
  const e = EMAIL_CODE_EMAIL;
  const lines = { intro: e.intro(code), use: e.use(VALID_MINUTES), ignore: e.ignore };

  const text = `${lines.intro}\n\n${lines.use}\n\n${lines.ignore}\n`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e.title}</title></head><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">
  <p>${e.introHtml}</p>
  <p style="margin:20px 0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:32px;font-weight:700;letter-spacing:6px">${code}</p>
  <p>${lines.use}</p>
  <p style="color:#666;font-size:13px;margin-top:28px">${lines.ignore}</p>
</body></html>`;
  return {
    to,
    subject: e.subject(code),
    text,
    html,
    track: { opens: false, clicks: false },
    tags: ["auth-code"],
  };
}

/** Send the email; a failure is logged (never the address, the code or the link) and otherwise dropped. */
async function deliver(message: EmailMessage, send: (msg: EmailMessage) => Promise<EmailResult>, what: "code" | "link" = "code"): Promise<void> {
  try {
    const res = await send(message);
    if (!res.sent && res.provider !== "log") {
      console.warn(`[auth-code] the ${what} email to an address at ${domainOf(message.to)} was not sent (${res.provider}: ${res.reason ?? "no reason"})`);
    }
  } catch (err) {
    console.warn(`[auth-code] the ${what} email failed:`, err instanceof Error ? err.message.slice(0, 200) : "error");
  }
}

function refused(error: "invalid_id_token" | "not_a_password_account"): EmailCodeAnswer {
  return error === "invalid_id_token" ? { status: 401, body: { error } } : { status: 400, body: { error } };
}

// --- POST: send a code or a link -------------------------------------------------------------

type VerifiedCaller = Extract<PasswordCaller, { ok: true }>;

/**
 * Everything a send goes through before anything is stored, codes and links alike: the per
 * visitor limit (before the token is looked at), the token, an account already confirmed, the
 * per account and per address limits, then the address's count in the database (which fails
 * closed). Only a code is stopped by the lock. A link with no platform origin stops before
 * anything is counted.
 */
async function startSend(
  input: { idToken: string; ip: string },
  deps: EmailCodeDeps,
  via: "code" | "link",
  now: Date,
): Promise<{ answer: EmailCodeAnswer } | { caller: VerifiedCaller }> {
  const limitOpts = { db: deps.db, now: now.getTime() };
  if (await isRateLimited(input.ip, EMAIL_CODE_LIMITS.ip, limitOpts)) return { answer: RATE_LIMITED };
  const caller = await verifyPasswordCaller(input.idToken, deps.auth ?? adminAuth());
  if (!caller.ok) return { answer: refused(caller.error) };
  if (isEmailConfirmed(caller.user)) return { answer: { status: 200, body: { ok: true, alreadyVerified: true } } };
  if (via === "link" && !linkOrigin()) {
    console.warn("[auth-code] no link was sent: NEXT_PUBLIC_PLATFORM_ORIGIN isn't set to this copy's address");
    return { answer: LINK_UNAVAILABLE };
  }
  if (await isRateLimited(caller.uid, EMAIL_CODE_LIMITS.uid, limitOpts)) return { answer: RATE_LIMITED };
  if (await isRateLimited(addressKey(caller.email), EMAIL_CODE_LIMITS.to, limitOpts)) return { answer: RATE_LIMITED };

  // The hard cap per address, kept in the database. A database error refuses the send.
  let claim: Awaited<ReturnType<typeof claimEmailCodeSend>>;
  try {
    claim = await claimEmailCodeSend(addressKey(caller.email), { now, db: deps.db, via });
  } catch (err) {
    console.warn(`[auth-code] counting a send failed, so no ${via} was sent:`, err instanceof Error ? err.message.slice(0, 200) : "error");
    return { answer: RATE_LIMITED };
  }
  if (claim !== "ok") {
    console.info(`[auth-code] an address at ${domainOf(caller.email)} got no ${via} (${claim})`);
    return { answer: claim === "shut_out" ? CODE_LOCKED_SEND : RATE_LIMITED };
  }
  return { caller };
}

/** Send a code to the caller's address. See the file comment for who gets one. */
export async function requestEmailCode(input: { idToken: string; ip: string }, deps: EmailCodeDeps = {}): Promise<EmailCodeAnswer> {
  const now = deps.now ?? new Date();
  const start = await startSend(input, deps, "code", now);
  if ("answer" in start) return start.answer;
  const { caller } = start;

  // Every caller gets a stored code, so a check answers the same whether or not one was emailed.
  const code = newEmailCode();
  await putEmailCode(caller.uid, hashEmailCode(caller.uid, caller.email, code), { now, db: deps.db });
  // The floor starts now, and the email goes out while it runs, still inside the request.
  const floor = (deps.sleep ?? wait)(SEND_FLOOR_MS);
  if (mayGetIn(caller.email)) {
    void deliver(emailCodeMessage(caller.email, code), deps.send ?? sendEmail);
  } else {
    console.info(`[auth-code] an address at ${domainOf(caller.email)} can't get in, so its code was not emailed`);
  }
  await floor;
  return { status: 200, body: { ok: true, resendAfter: RESEND_AFTER_SECONDS } };
}

/**
 * Email a link that confirms the caller's address, in place of a code (the code screen offers it
 * once the address is locked). The same gate, answers and timing as a code: the link is made and
 * stored for every caller, emailed only when the address may get in, and every answer waits for
 * SEND_FLOOR_MS. 200 { ok: true, via: "link" }, or 503 link_unavailable with no platform origin.
 */
export async function requestEmailLink(input: { idToken: string; ip: string }, deps: EmailCodeDeps = {}): Promise<EmailCodeAnswer> {
  const now = deps.now ?? new Date();
  const start = await startSend(input, deps, "link", now);
  if ("answer" in start) return start.answer;
  const { caller } = start;

  const token = newEmailLinkToken();
  const url = confirmLinkUrl(token);
  if (!url) return LINK_UNAVAILABLE;
  await putEmailLink(caller.uid, hashEmailLink(caller.uid, caller.email, token), { now, db: deps.db });
  const floor = (deps.sleep ?? wait)(SEND_FLOOR_MS);
  if (mayGetIn(caller.email)) {
    void deliver(emailLinkMessage(caller.email, url), deps.send ?? sendEmail, "link");
  } else {
    console.info(`[auth-code] an address at ${domainOf(caller.email)} can't get in, so its link was not emailed`);
  }
  await floor;
  return { status: 200, body: { ok: true, via: "link" } };
}

// --- PUT: check a code ------------------------------------------------------------------------

/** Check a typed code; right, confirm the account and delete the code. */
export async function confirmEmailCode(
  input: { idToken: string; code: string; ip: string },
  deps: EmailCodeDeps = {},
): Promise<EmailCodeAnswer> {
  if (!CODE_RE.test(input.code)) return { status: 400, body: { error: "invalid_input" } };
  const now = deps.now ?? new Date();
  if (await isRateLimited(input.ip, EMAIL_CODE_LIMITS.checkIp, { db: deps.db, now: now.getTime() })) return RATE_LIMITED;
  const auth = deps.auth ?? adminAuth();
  const caller = await verifyPasswordCaller(input.idToken, auth);
  if (!caller.ok) return refused(caller.error);

  const check = await checkEmailCode(caller.uid, hashEmailCode(caller.uid, caller.email, input.code), {
    now,
    db: deps.db,
    addressKey: addressKey(caller.email),
  });
  if (!check.ok) {
    if (check.why === "wrong") return { status: 400, body: { error: "code_wrong", attemptsLeft: check.attemptsLeft } };
    if (check.why === "too_many") return { status: 400, body: { error: "code_too_many" } };
    if (check.why === "locked") {
      if (check.justLocked) logCodeLocked(caller.email);
      return { status: 400, body: { error: "code_locked" } };
    }
    return { status: 400, body: { error: "code_expired" } };
  }

  await markConfirmed(auth, caller);
  // A link sent earlier goes too: once the account is confirmed, nothing should stay live for it.
  for (const [what, remove] of [
    ["code", deleteEmailCode],
    ["link", deleteEmailLink],
  ] as const) {
    try {
      await remove(caller.uid, { db: deps.db });
    } catch (err) {
      // The account is confirmed; what is left can only confirm it again, and its time to live removes it.
      console.warn(`[auth-code] deleting a used ${what} failed:`, err instanceof Error ? err.message.slice(0, 200) : "error");
    }
  }
  return { status: 200, body: { ok: true } };
}

/**
 * The marker first: if the second call fails, the account is still unconfirmed at the door
 * (email_not_verified, so it can confirm again), never verified without the marker, which the
 * door would read as unexplained and remove.
 */
async function markConfirmed(auth: EmailCodeAuth, caller: VerifiedCaller): Promise<void> {
  await auth.setCustomUserClaims(caller.uid, { ...(caller.user.customClaims ?? {}), [EMAIL_CODE_CLAIM]: true });
  await auth.updateUser(caller.uid, { emailVerified: true });
}

// --- PUT: open a link -------------------------------------------------------------------------

/**
 * Check an opened link for the signed-in account; right, confirm the account exactly as a right
 * code does, then delete the link and any code. Every refusal is 400 link_invalid: no link, another
 * account's or another address's link, a replaced one, expired or already used. The lock on codes
 * plays no part.
 */
export async function confirmEmailLink(
  input: { idToken: string; link: string; ip: string },
  deps: EmailCodeDeps = {},
): Promise<EmailCodeAnswer> {
  if (!LINK_TOKEN_RE.test(input.link)) return { status: 400, body: { error: "invalid_input" } };
  const now = deps.now ?? new Date();
  if (await isRateLimited(input.ip, EMAIL_CODE_LIMITS.linkCheckIp, { db: deps.db, now: now.getTime() })) return RATE_LIMITED;
  const auth = deps.auth ?? adminAuth();
  const caller = await verifyPasswordCaller(input.idToken, auth);
  if (!caller.ok) return refused(caller.error);

  const check = await checkEmailLink(caller.uid, hashEmailLink(caller.uid, caller.email, input.link), { now, db: deps.db });
  if (!check.ok) {
    console.info(`[auth-code] a link for an address at ${domainOf(caller.email)} was refused (${check.why})`);
    return LINK_INVALID;
  }

  await markConfirmed(auth, caller);
  for (const [what, remove] of [
    ["link", deleteEmailLink],
    ["code", deleteEmailCode],
  ] as const) {
    try {
      await remove(caller.uid, { db: deps.db });
    } catch (err) {
      // The account is confirmed; what is left can only confirm it again, and its time to live removes it.
      console.warn(`[auth-code] deleting a used ${what} failed:`, err instanceof Error ? err.message.slice(0, 200) : "error");
    }
  }
  return { status: 200, body: { ok: true } };
}
