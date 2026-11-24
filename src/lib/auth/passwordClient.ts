"use client";

import { initializeRecaptchaConfig, validatePassword, type Auth, type PasswordValidationStatus } from "firebase/auth";
import { isNavV2Enabled } from "@/lib/nav/flags";
import { safeNextPath } from "./clientSession";
import { getClientAuth } from "./firebaseClient";
import { AUTH_MESSAGES, PASSWORD_MIN_LENGTH } from "./messages";

/**
 * Browser helpers for email and password sign-in: what to say when Firebase Auth refuses, the
 * password check people see before anything is sent, and the calls to /api/auth/email-code.
 * Passwords go from the browser to Identity Platform only; nothing here sends one to our server.
 */

/** The Firebase Auth instances whose reCAPTCHA config is loaded or loading. */
const botChecksStarted = new WeakSet<Auth>();

/**
 * Load the project's reCAPTCHA config once per page, before any password call. Without it Firebase
 * sends password sign-ins, sign-ups and reset emails with no reCAPTCHA token, so audit mode has no
 * scores to show and enforce mode would refuse the first try. The Auth emulator has no reCAPTCHA,
 * so nothing is loaded there. A failure is dropped (password calls still work while reCAPTCHA is
 * off or in audit) and the next call tries again.
 */
export function startPasswordBotChecks(auth: Auth, init: (auth: Auth) => Promise<void> = initializeRecaptchaConfig): void {
  if (auth.emulatorConfig || botChecksStarted.has(auth)) return;
  botChecksStarted.add(auth);
  init(auth).catch(() => botChecksStarted.delete(auth));
}

/** The step that failed, so one Firebase error code can mean different things on each screen. */
export type AuthAction = "sign_in" | "create" | "google" | "reset";

/** Firebase errors that need no message: the person closed the Google window themselves. */
const SILENT_CODES = new Set(["auth/popup-closed-by-user", "auth/cancelled-popup-request", "auth/user-cancelled"]);

/** Firebase's refusals of the continue URL: the reset email is sent again without one. */
const CONTINUE_URL_CODES = new Set(["auth/unauthorized-continue-uri", "auth/invalid-continue-uri", "auth/missing-continue-uri"]);

/** The Firebase Auth error code on a thrown value ("auth/wrong-password"), or null. */
export function authErrorCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("auth/") ? code : null;
}

/** The address Firebase names on an "account exists" error, so the email field can be filled in. */
export function authErrorEmail(err: unknown): string | null {
  const email = (err as { customData?: { email?: unknown } } | null)?.customData?.email;
  return typeof email === "string" && email ? email : null;
}

/**
 * What to tell people when Firebase Auth refuses at this step, or null when there is nothing to
 * say. Sign in never says whether an address has an account: a wrong password and an unknown
 * address read the same.
 */
export function authErrorMessage(err: unknown, action: AuthAction): string | null {
  const code = authErrorCode(err);
  if (code && SILENT_CODES.has(code)) return null;
  switch (code) {
    case "auth/too-many-requests":
      return action === "sign_in" ? AUTH_MESSAGES.tooManyTries : AUTH_MESSAGES.tooManyTriesWait;
    case "auth/user-disabled":
      return AUTH_MESSAGES.accountDisabled;
    case "auth/operation-not-allowed":
    case "auth/admin-restricted-operation":
      return action === "google" ? AUTH_MESSAGES.somethingWentWrong : AUTH_MESSAGES.passwordUnavailable;
  }
  switch (action) {
    case "google":
      if (code === "auth/account-exists-with-different-credential") return AUTH_MESSAGES.usePasswordInstead;
      if (code === "auth/popup-blocked") return AUTH_MESSAGES.popupBlocked;
      break;
    case "sign_in":
      if (
        code === "auth/invalid-credential" ||
        code === "auth/invalid-login-credentials" ||
        code === "auth/wrong-password" ||
        code === "auth/user-not-found" ||
        code === "auth/missing-password"
      ) {
        return AUTH_MESSAGES.wrongPassword;
      }
      if (code === "auth/invalid-email" || code === "auth/missing-email") return AUTH_MESSAGES.emailLooksWrong;
      if (code === "auth/password-does-not-meet-requirements") return AUTH_MESSAGES.passwordNeedsReset;
      break;
    case "create":
      if (code === "auth/email-already-in-use") return AUTH_MESSAGES.emailInUse;
      if (code === "auth/invalid-email" || code === "auth/missing-email") return AUTH_MESSAGES.emailLooksWrong;
      if (code === "auth/weak-password" || code === "auth/missing-password") return AUTH_MESSAGES.passwordTooShort;
      if (code === "auth/password-does-not-meet-requirements") return AUTH_MESSAGES.passwordRulesNotMet;
      break;
    case "reset":
      if (code === "auth/expired-action-code" || code === "auth/invalid-action-code" || code === "auth/user-not-found") {
        return AUTH_MESSAGES.resetLinkBad;
      }
      if (code === "auth/weak-password" || code === "auth/missing-password") return AUTH_MESSAGES.passwordTooShort;
      if (code === "auth/password-does-not-meet-requirements") return AUTH_MESSAGES.passwordRulesNotMet;
      break;
  }
  return AUTH_MESSAGES.somethingWentWrong;
}

/**
 * Refusals that can depend on whether the address has an account. They read as "sent", so the
 * answer never says which addresses have one.
 */
const FORGOT_ACCOUNT_CODES = new Set(["auth/user-not-found", "auth/user-disabled", "auth/too-many-requests"]);

/**
 * After Send reset link: "sent" shows resetSentMessage, the same answer whether or not the address
 * has an account. Any other failure (reCAPTCHA, quota, network, an error with no code) happened
 * before Firebase looked the address up, so it says nothing about the account and nothing was
 * sent: it gets a message, never "sent".
 */
export function forgotOutcome(err: unknown): "sent" | string {
  if (err == null) return "sent";
  const code = authErrorCode(err);
  if (code && FORGOT_ACCOUNT_CODES.has(code)) return "sent";
  switch (code) {
    case "auth/invalid-email":
    case "auth/missing-email":
      return AUTH_MESSAGES.emailLooksWrong;
    case "auth/operation-not-allowed":
    case "auth/admin-restricted-operation":
      return AUTH_MESSAGES.passwordUnavailable;
    default:
      return AUTH_MESSAGES.somethingWentWrong;
  }
}

/** Firebase refused the reset email's continue URL (a domain it doesn't list): send it without one. */
export function isContinueUrlRefused(err: unknown): boolean {
  const code = authErrorCode(err);
  return code !== null && CONTINUE_URL_CODES.has(code);
}

/** Where the reset email's link sends people once the new password is saved. */
export function resetContinueUrl(origin: string): string {
  return `${origin}/login`;
}

/** A light check before anything is sent: one @, something either side, a dot in the domain. */
export function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/** The password rule people see up front: the length, or null when it passes. */
export function passwordLengthProblem(password: string): string | null {
  return password.length < PASSWORD_MIN_LENGTH ? AUTH_MESSAGES.passwordTooShort : null;
}

/** Checks a password against the project's policy (Identity Platform). */
export type PasswordValidator = (password: string) => Promise<PasswordValidationStatus>;

const projectPolicy: PasswordValidator = (password) => validatePassword(getClientAuth(), password);

/**
 * Checks a new password before it goes to Identity Platform: the length first, then the project's
 * own policy. When the policy can't be read (offline, the emulator, an older project) the length
 * rule stands alone; Identity Platform enforces its policy again when the password is saved.
 */
export async function newPasswordProblem(password: string, validate: PasswordValidator = projectPolicy): Promise<string | null> {
  const short = passwordLengthProblem(password);
  if (short) return short;
  let status: PasswordValidationStatus;
  try {
    status = await validate(password);
  } catch {
    return null;
  }
  if (status.isValid) return null;
  return status.meetsMinPasswordLength === false ? AUTH_MESSAGES.passwordTooShort : AUTH_MESSAGES.passwordRulesNotMet;
}

/** The answer to "send me a code" (POST /api/auth/email-code). */
export type SendCodeResult =
  | { kind: "sent"; resendAfter: number }
  | { kind: "already_verified" }
  | { kind: "rate_limited" }
  | { kind: "unavailable" }
  | { kind: "error" };

/** The answer to "check this code" (PUT /api/auth/email-code). */
export type CheckCodeResult =
  | { kind: "ok" }
  | { kind: "wrong"; attemptsLeft: number | null }
  | { kind: "expired" }
  | { kind: "too_many" }
  | { kind: "invalid" }
  | { kind: "rate_limited" }
  | { kind: "unavailable" }
  | { kind: "error" };

/** Seconds before the code screen offers another code when the server doesn't say. */
export const DEFAULT_RESEND_AFTER = 30;

async function callEmailCode(method: "POST" | "PUT", body: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch("/api/auth/email-code", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => ({}))) as unknown;
  return { status: res.status, body: parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {} };
}

/** Asks the server to email a 6-digit code to the signed-in password account. Never throws. */
export async function requestEmailCode(idToken: string): Promise<SendCodeResult> {
  try {
    const { status, body } = await callEmailCode("POST", { idToken });
    if (status === 200 && body.ok === true) {
      if (body.alreadyVerified === true) return { kind: "already_verified" };
      const after = typeof body.resendAfter === "number" && body.resendAfter >= 0 ? body.resendAfter : DEFAULT_RESEND_AFTER;
      return { kind: "sent", resendAfter: after };
    }
    if (status === 429) return { kind: "rate_limited" };
    if (status === 503) return { kind: "unavailable" };
    return { kind: "error" };
  } catch {
    return { kind: "error" };
  }
}

/** Sends the typed code to the server to check. Never throws. */
export async function checkEmailCode(idToken: string, code: string): Promise<CheckCodeResult> {
  try {
    const { status, body } = await callEmailCode("PUT", { idToken, code });
    if (status === 200 && body.ok === true) return { kind: "ok" };
    if (status === 429) return { kind: "rate_limited" };
    if (status === 503) return { kind: "unavailable" };
    if (status === 400) {
      switch (body.error) {
        case "code_wrong":
          return { kind: "wrong", attemptsLeft: typeof body.attemptsLeft === "number" ? body.attemptsLeft : null };
        case "code_expired":
          return { kind: "expired" };
        case "code_too_many":
          return { kind: "too_many" };
        case "invalid_input":
          return { kind: "invalid" };
      }
    }
    return { kind: "error" };
  } catch {
    return { kind: "error" };
  }
}

/**
 * Checks codes for the code screen and remembers each account whose code was accepted. The server
 * deletes a code once it matches, so when a later step fails (the fresh token, or the door) the
 * retry must not check again: it would answer "expired" for an address that is already confirmed.
 */
export function emailCodeChecker(check: typeof checkEmailCode = checkEmailCode) {
  const accepted = new Set<string>();
  return {
    async check(uid: string, idToken: () => Promise<string>, code: string): Promise<CheckCodeResult> {
      if (accepted.has(uid)) return { kind: "ok" };
      const result = await check(await idToken(), code);
      if (result.kind === "ok") accepted.add(uid);
      return result;
    },
    /** Forgets every accepted code, for "Start again". */
    forget(): void {
      accepted.clear();
    },
  };
}

/** What the code screen says after asking for a code, or null when the code is on its way. */
export function sendCodeMessage(result: SendCodeResult): string | null {
  switch (result.kind) {
    case "sent":
    case "already_verified":
      return null;
    case "rate_limited":
      return AUTH_MESSAGES.codeRateLimited;
    case "unavailable":
      return AUTH_MESSAGES.passwordUnavailable;
    case "error":
      return AUTH_MESSAGES.somethingWentWrong;
  }
}

/** What the code screen says after a check, or null when the code was right. */
export function checkCodeMessage(result: CheckCodeResult): string | null {
  switch (result.kind) {
    case "ok":
      return null;
    case "wrong":
      return AUTH_MESSAGES.codeWrong;
    case "expired":
      return AUTH_MESSAGES.codeExpired;
    case "too_many":
      return AUTH_MESSAGES.codeTooMany;
    case "invalid":
      return AUTH_MESSAGES.codeIncomplete;
    case "rate_limited":
      return AUTH_MESSAGES.tooManyTriesWait;
    case "unavailable":
      return AUTH_MESSAGES.passwordUnavailable;
    case "error":
      return AUTH_MESSAGES.somethingWentWrong;
  }
}

/** Only digits, at most 6: what the code field keeps of what was typed or pasted. */
export function cleanCode(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, 6);
}

/** The reset email's link, read from /auth/reset's query. */
export type ResetLink =
  | { kind: "reset"; oobCode: string }
  | { kind: "recover"; oobCode: string }
  | { kind: "wrong_mode" }
  | { kind: "bad" }
  | { kind: "empty" };

/**
 * Reads the reset email's link (?mode=resetPassword&oobCode=...), or Firebase's "undo the email
 * change" link (?mode=recoverEmail). Other modes (verify an email, confirm a new one) are links
 * YouGrow doesn't use. "empty" is no link at all: the page took the
 * link out of the address bar, so a reload lands here while the link in the email still works.
 */
export function readResetLink(search: string): ResetLink {
  const params = new URLSearchParams(search);
  const mode = params.get("mode");
  const oobCode = params.get("oobCode")?.trim();
  if (!params.has("mode") && !params.has("oobCode")) return { kind: "empty" };
  // The setup step points every Firebase email's link here, so "undo an email change" lands here
  // too: someone whose address was changed without them must be able to change it back.
  if (mode === "recoverEmail") return oobCode ? { kind: "recover", oobCode } : { kind: "bad" };
  if (mode && mode !== "resetPassword") return { kind: "wrong_mode" };
  if (mode !== "resetPassword" || !oobCode) return { kind: "bad" };
  return { kind: "reset", oobCode };
}

/** Where a fresh sign-in goes: the checked ?next= path, else the admin home. */
export function afterSignInPath(search: string): string {
  return safeNextPath(new URLSearchParams(search).get("next")) ?? (isNavV2Enabled() ? "/admin" : "/admin/signups");
}
