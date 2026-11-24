import { createHash, randomInt } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import type { Auth, DecodedIdToken, UserRecord } from "firebase-admin/auth";
import { sendEmail, type EmailMessage, type EmailResult } from "@/lib/email";
import {
  checkEmailCode,
  claimEmailCodeSend,
  deleteEmailCode,
  EMAIL_CODE_VALID_MS,
  isRateLimited,
  putEmailCode,
  type RateLimitConfig,
} from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { adminAuth } from "./adminAuth";
import { isListedAdminEmail } from "./allowlist";
import { isSelfServeSignupOpen } from "./flags";
import { EMAIL_CODE_EMAIL } from "./messages";

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
 * - The email holds the code and fixed words only: nothing the account holder typed.
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
} as const satisfies Record<string, RateLimitConfig>;

const CODE_RE = /^\d{6}$/;
const VALID_MINUTES = EMAIL_CODE_VALID_MS / 60_000;

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

/** Send the email; a failure is logged (never the address or the code) and otherwise dropped. */
async function deliver(message: EmailMessage, send: (msg: EmailMessage) => Promise<EmailResult>): Promise<void> {
  try {
    const res = await send(message);
    if (!res.sent && res.provider !== "log") {
      console.warn(`[auth-code] the code email to an address at ${domainOf(message.to)} was not sent (${res.provider}: ${res.reason ?? "no reason"})`);
    }
  } catch (err) {
    console.warn("[auth-code] the code email failed:", err instanceof Error ? err.message.slice(0, 200) : "error");
  }
}

function refused(error: "invalid_id_token" | "not_a_password_account"): EmailCodeAnswer {
  return error === "invalid_id_token" ? { status: 401, body: { error } } : { status: 400, body: { error } };
}

// --- POST: send a code ------------------------------------------------------------------------

/** Send a code to the caller's address. See the file comment for who gets one. */
export async function requestEmailCode(input: { idToken: string; ip: string }, deps: EmailCodeDeps = {}): Promise<EmailCodeAnswer> {
  const now = deps.now ?? new Date();
  const limitOpts = { db: deps.db, now: now.getTime() };
  if (await isRateLimited(input.ip, EMAIL_CODE_LIMITS.ip, limitOpts)) return RATE_LIMITED;
  const caller = await verifyPasswordCaller(input.idToken, deps.auth ?? adminAuth());
  if (!caller.ok) return refused(caller.error);
  if (isEmailConfirmed(caller.user)) return { status: 200, body: { ok: true, alreadyVerified: true } };
  if (await isRateLimited(caller.uid, EMAIL_CODE_LIMITS.uid, limitOpts)) return RATE_LIMITED;
  if (await isRateLimited(addressKey(caller.email), EMAIL_CODE_LIMITS.to, limitOpts)) return RATE_LIMITED;

  // The hard cap per address, kept in the database. A database error refuses the send.
  let claim: Awaited<ReturnType<typeof claimEmailCodeSend>>;
  try {
    claim = await claimEmailCodeSend(addressKey(caller.email), { now, db: deps.db });
  } catch (err) {
    console.warn("[auth-code] counting a send failed, so none was sent:", err instanceof Error ? err.message.slice(0, 200) : "error");
    return RATE_LIMITED;
  }
  if (claim !== "ok") {
    console.info(`[auth-code] an address at ${domainOf(caller.email)} got no code (${claim})`);
    return RATE_LIMITED;
  }

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
    return { status: 400, body: { error: "code_expired" } };
  }

  // The marker first: if the second call fails, the account is still unconfirmed at the door
  // (email_not_verified, so it can confirm again), never verified without the marker, which the
  // door would read as unexplained and remove.
  await auth.setCustomUserClaims(caller.uid, { ...(caller.user.customClaims ?? {}), [EMAIL_CODE_CLAIM]: true });
  await auth.updateUser(caller.uid, { emailVerified: true });
  try {
    await deleteEmailCode(caller.uid, { db: deps.db });
  } catch (err) {
    // The account is confirmed; the leftover code can only confirm it again, and its time to live removes it.
    console.warn("[auth-code] deleting a used code failed:", err instanceof Error ? err.message.slice(0, 200) : "error");
  }
  return { status: 200, body: { ok: true } };
}
