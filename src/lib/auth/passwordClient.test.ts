import { afterEach, describe, expect, it, vi } from "vitest";
import type { Auth, PasswordValidationStatus } from "firebase/auth";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import {
  AUTH_LABELS,
  AUTH_MESSAGES,
  codeSentMessage,
  resendInMessage,
  resetForMessage,
  resetSentMessage,
} from "./messages";
import {
  afterSignInPath,
  authErrorCode,
  authErrorEmail,
  authErrorMessage,
  checkCodeMessage,
  checkEmailCode,
  cleanCode,
  DEFAULT_RESEND_AFTER,
  emailCodeChecker,
  forgotOutcome,
  isContinueUrlRefused,
  looksLikeEmail,
  newPasswordProblem,
  passwordLengthProblem,
  readResetLink,
  requestEmailCode,
  resetContinueUrl,
  sendCodeMessage,
  startPasswordBotChecks,
} from "./passwordClient";

/** A thrown Firebase Auth error, as the client SDK shapes it. */
const fbErr = (code: string, customData?: Record<string, unknown>) => Object.assign(new Error(code), { code, customData });

describe("authErrorMessage", () => {
  it("never says whether an address has an account when signing in", () => {
    for (const code of ["auth/invalid-credential", "auth/invalid-login-credentials", "auth/wrong-password", "auth/user-not-found", "auth/missing-password"]) {
      expect(authErrorMessage(fbErr(code), "sign_in"), code).toBe(AUTH_MESSAGES.wrongPassword);
    }
  });

  it("maps each sign in refusal to its message", () => {
    expect(authErrorMessage(fbErr("auth/too-many-requests"), "sign_in")).toBe(AUTH_MESSAGES.tooManyTries);
    expect(authErrorMessage(fbErr("auth/invalid-email"), "sign_in")).toBe(AUTH_MESSAGES.emailLooksWrong);
    expect(authErrorMessage(fbErr("auth/user-disabled"), "sign_in")).toBe(AUTH_MESSAGES.accountDisabled);
    expect(authErrorMessage(fbErr("auth/operation-not-allowed"), "sign_in")).toBe(AUTH_MESSAGES.passwordUnavailable);
    expect(authErrorMessage(fbErr("auth/password-does-not-meet-requirements"), "sign_in")).toBe(AUTH_MESSAGES.passwordNeedsReset);
  });

  it("maps each create account refusal to its message", () => {
    expect(authErrorMessage(fbErr("auth/email-already-in-use"), "create")).toBe(AUTH_MESSAGES.emailInUse);
    expect(authErrorMessage(fbErr("auth/missing-email"), "create")).toBe(AUTH_MESSAGES.emailLooksWrong);
    expect(authErrorMessage(fbErr("auth/weak-password"), "create")).toBe(AUTH_MESSAGES.passwordTooShort);
    expect(authErrorMessage(fbErr("auth/password-does-not-meet-requirements"), "create")).toBe(AUTH_MESSAGES.passwordRulesNotMet);
    expect(authErrorMessage(fbErr("auth/admin-restricted-operation"), "create")).toBe(AUTH_MESSAGES.passwordUnavailable);
    expect(authErrorMessage(fbErr("auth/too-many-requests"), "create")).toBe(AUTH_MESSAGES.tooManyTriesWait);
  });

  it("tells a Google sign-in on a password address to use the password, and stays quiet when the window is closed", () => {
    expect(authErrorMessage(fbErr("auth/account-exists-with-different-credential"), "google")).toBe(AUTH_MESSAGES.usePasswordInstead);
    expect(authErrorMessage(fbErr("auth/popup-blocked"), "google")).toBe(AUTH_MESSAGES.popupBlocked);
    expect(authErrorMessage(fbErr("auth/popup-closed-by-user"), "google")).toBeNull();
    expect(authErrorMessage(fbErr("auth/cancelled-popup-request"), "google")).toBeNull();
    // Password wording never shows for Google.
    expect(authErrorMessage(fbErr("auth/invalid-credential"), "google")).toBe(AUTH_MESSAGES.somethingWentWrong);
    expect(authErrorMessage(fbErr("auth/operation-not-allowed"), "google")).toBe(AUTH_MESSAGES.somethingWentWrong);
  });

  it("maps a reset link that can't be used, and the password rules, on the reset page", () => {
    for (const code of ["auth/expired-action-code", "auth/invalid-action-code", "auth/user-not-found"]) {
      expect(authErrorMessage(fbErr(code), "reset"), code).toBe(AUTH_MESSAGES.resetLinkBad);
    }
    expect(authErrorMessage(fbErr("auth/weak-password"), "reset")).toBe(AUTH_MESSAGES.passwordTooShort);
    expect(authErrorMessage(fbErr("auth/password-does-not-meet-requirements"), "reset")).toBe(AUTH_MESSAGES.passwordRulesNotMet);
  });

  it("falls back to something went wrong for anything else, including non Firebase errors", () => {
    expect(authErrorMessage(fbErr("auth/network-request-failed"), "sign_in")).toBe(AUTH_MESSAGES.somethingWentWrong);
    expect(authErrorMessage(new Error("boom"), "create")).toBe(AUTH_MESSAGES.somethingWentWrong);
    expect(authErrorMessage(null, "reset")).toBe(AUTH_MESSAGES.somethingWentWrong);
    expect(authErrorMessage("auth/wrong-password", "sign_in")).toBe(AUTH_MESSAGES.somethingWentWrong);
  });

  it("reads the code and the named address off an error", () => {
    expect(authErrorCode(fbErr("auth/user-disabled"))).toBe("auth/user-disabled");
    expect(authErrorCode({ code: "storage/unknown" })).toBeNull();
    expect(authErrorCode(undefined)).toBeNull();
    expect(authErrorEmail(fbErr("auth/account-exists-with-different-credential", { email: "alex@example.com" }))).toBe("alex@example.com");
    expect(authErrorEmail(fbErr("auth/account-exists-with-different-credential"))).toBeNull();
  });
});

describe("forgot password", () => {
  it("gives the same answer whether or not the address has an account", () => {
    expect(forgotOutcome(null)).toBe("sent");
    expect(forgotOutcome(fbErr("auth/user-not-found"))).toBe("sent");
    expect(forgotOutcome(fbErr("auth/too-many-requests"))).toBe("sent");
    expect(forgotOutcome(fbErr("auth/user-disabled"))).toBe("sent");
  });

  it("names only problems the person can fix", () => {
    expect(forgotOutcome(fbErr("auth/invalid-email"))).toBe(AUTH_MESSAGES.emailLooksWrong);
    expect(forgotOutcome(fbErr("auth/network-request-failed"))).toBe(AUTH_MESSAGES.somethingWentWrong);
    expect(forgotOutcome(fbErr("auth/operation-not-allowed"))).toBe(AUTH_MESSAGES.passwordUnavailable);
  });

  it("never says a link is on its way when the request failed before the account was looked up", () => {
    for (const code of [
      "auth/missing-recaptcha-token",
      "auth/invalid-recaptcha-token",
      "auth/recaptcha-not-enabled",
      "auth/internal-error",
      "auth/quota-exceeded",
      "auth/unauthorized-continue-uri",
    ]) {
      expect(forgotOutcome(fbErr(code)), code).toBe(AUTH_MESSAGES.somethingWentWrong);
    }
    expect(forgotOutcome(new Error("reCAPTCHA script failed to load"))).toBe(AUTH_MESSAGES.somethingWentWrong);
    expect(forgotOutcome({ code: "something-else" })).toBe(AUTH_MESSAGES.somethingWentWrong);
  });

  it("sends the link back to /login, and retries without it when Firebase refuses the address", () => {
    expect(resetContinueUrl("https://app.example.com")).toBe("https://app.example.com/login");
    expect(isContinueUrlRefused(fbErr("auth/unauthorized-continue-uri"))).toBe(true);
    expect(isContinueUrlRefused(fbErr("auth/invalid-continue-uri"))).toBe(true);
    expect(isContinueUrlRefused(fbErr("auth/user-not-found"))).toBe(false);
    expect(isContinueUrlRefused(new Error("x"))).toBe(false);
  });
});

describe("checks before anything is sent", () => {
  it("accepts ordinary addresses and refuses obvious typos", () => {
    expect(looksLikeEmail("alex@example.com")).toBe(true);
    expect(looksLikeEmail("  sam.lee+work@mail.example.test ")).toBe(true);
    for (const bad of ["", "alex", "alex@", "@example.com", "alex@example", "a b@example.com"]) {
      expect(looksLikeEmail(bad), bad).toBe(false);
    }
  });

  it("checks the length first, without asking the policy", async () => {
    const validate = vi.fn();
    expect(passwordLengthProblem("short")).toBe(AUTH_MESSAGES.passwordTooShort);
    await expect(newPasswordProblem("elevenchars", validate)).resolves.toBe(AUTH_MESSAGES.passwordTooShort);
    expect(validate).not.toHaveBeenCalled();
  });

  it("then asks the project's policy", async () => {
    const status = (s: Partial<PasswordValidationStatus>) => async () => ({ isValid: false, passwordPolicy: {} as never, ...s }) as PasswordValidationStatus;
    await expect(newPasswordProblem("a long enough one", status({ isValid: true }))).resolves.toBeNull();
    await expect(newPasswordProblem("a long enough one", status({ meetsMinPasswordLength: false }))).resolves.toBe(AUTH_MESSAGES.passwordTooShort);
    await expect(newPasswordProblem("a long enough one", status({ containsNumericCharacter: false }))).resolves.toBe(AUTH_MESSAGES.passwordRulesNotMet);
  });

  it("falls back to the length rule when the policy can't be read", async () => {
    await expect(newPasswordProblem("a long enough one", async () => Promise.reject(new Error("offline")))).resolves.toBeNull();
  });

  it("keeps only six digits of a typed or pasted code", () => {
    expect(cleanCode("481 920")).toBe("481920");
    expect(cleanCode("4-8-1-9-2-0-7")).toBe("481920");
    expect(cleanCode("abc")).toBe("");
  });
});

describe("the email code route", () => {
  afterEach(() => vi.unstubAllGlobals());

  const respond = (status: number, body: unknown) => {
    const fetchMock = vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  it("posts only the ID token to ask for a code", async () => {
    const fetchMock = respond(200, { ok: true, resendAfter: 30 });
    await expect(requestEmailCode("id-token")).resolves.toEqual({ kind: "sent", resendAfter: 30 });
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/email-code", expect.objectContaining({ method: "POST", body: JSON.stringify({ idToken: "id-token" }) }));
  });

  it("reads each answer to a send", async () => {
    respond(200, { ok: true, alreadyVerified: true });
    await expect(requestEmailCode("t")).resolves.toEqual({ kind: "already_verified" });
    respond(200, { ok: true });
    await expect(requestEmailCode("t")).resolves.toEqual({ kind: "sent", resendAfter: DEFAULT_RESEND_AFTER });
    respond(429, { error: "rate_limited" });
    await expect(requestEmailCode("t")).resolves.toEqual({ kind: "rate_limited" });
    respond(503, { error: "password_signin_disabled" });
    await expect(requestEmailCode("t")).resolves.toEqual({ kind: "unavailable" });
    respond(400, { error: "not_a_password_account" });
    await expect(requestEmailCode("t")).resolves.toEqual({ kind: "error" });
    respond(500, "not json");
    await expect(requestEmailCode("t")).resolves.toEqual({ kind: "error" });
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));
    await expect(requestEmailCode("t")).resolves.toEqual({ kind: "error" });
  });

  it("puts the token and the code to check one", async () => {
    const fetchMock = respond(200, { ok: true });
    await expect(checkEmailCode("id-token", "481920")).resolves.toEqual({ kind: "ok" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/email-code",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ idToken: "id-token", code: "481920" }) }),
    );
  });

  it("reads each answer to a check", async () => {
    respond(400, { error: "code_wrong", attemptsLeft: 3 });
    await expect(checkEmailCode("t", "000000")).resolves.toEqual({ kind: "wrong", attemptsLeft: 3 });
    respond(400, { error: "code_expired" });
    await expect(checkEmailCode("t", "000000")).resolves.toEqual({ kind: "expired" });
    respond(400, { error: "code_too_many" });
    await expect(checkEmailCode("t", "000000")).resolves.toEqual({ kind: "too_many" });
    respond(400, { error: "invalid_input" });
    await expect(checkEmailCode("t", "1")).resolves.toEqual({ kind: "invalid" });
    respond(429, { error: "rate_limited" });
    await expect(checkEmailCode("t", "000000")).resolves.toEqual({ kind: "rate_limited" });
    respond(503, { error: "password_signin_disabled" });
    await expect(checkEmailCode("t", "000000")).resolves.toEqual({ kind: "unavailable" });
    respond(401, { error: "invalid_id_token" });
    await expect(checkEmailCode("t", "000000")).resolves.toEqual({ kind: "error" });
  });

  it("doesn't check an accepted code again, so a retry after the door failed isn't told it expired", async () => {
    // The server deletes a code once it matches: checking it again would answer "expired".
    const check = vi.fn<typeof checkEmailCode>(async () => ({ kind: "ok" }));
    const token = vi.fn(async () => "t");
    const codes = emailCodeChecker(check);
    await expect(codes.check("uid-a", token, "481920")).resolves.toEqual({ kind: "ok" });
    check.mockResolvedValue({ kind: "expired" });
    await expect(codes.check("uid-a", token, "481920")).resolves.toEqual({ kind: "ok" });
    expect(check).toHaveBeenCalledTimes(1);
    // Another account still has its code checked, and Start again forgets the first one.
    await expect(codes.check("uid-b", token, "481920")).resolves.toEqual({ kind: "expired" });
    codes.forget();
    await expect(codes.check("uid-a", token, "481920")).resolves.toEqual({ kind: "expired" });
  });

  it("checks again after a code that was not accepted", async () => {
    const check = vi.fn<typeof checkEmailCode>(async () => ({ kind: "wrong", attemptsLeft: 4 }));
    const codes = emailCodeChecker(check);
    await codes.check("uid-a", async () => "t", "000000");
    check.mockResolvedValue({ kind: "ok" });
    await expect(codes.check("uid-a", async () => "t", "481920")).resolves.toEqual({ kind: "ok" });
    expect(check).toHaveBeenCalledTimes(2);
    expect(check).toHaveBeenLastCalledWith("t", "481920");
  });

  it("says the matching message for each answer", () => {
    expect(sendCodeMessage({ kind: "sent", resendAfter: 30 })).toBeNull();
    expect(sendCodeMessage({ kind: "rate_limited" })).toBe(AUTH_MESSAGES.codeRateLimited);
    expect(sendCodeMessage({ kind: "unavailable" })).toBe(AUTH_MESSAGES.passwordUnavailable);
    expect(sendCodeMessage({ kind: "error" })).toBe(AUTH_MESSAGES.somethingWentWrong);
    expect(checkCodeMessage({ kind: "ok" })).toBeNull();
    expect(checkCodeMessage({ kind: "wrong", attemptsLeft: 2 })).toBe(AUTH_MESSAGES.codeWrong);
    expect(checkCodeMessage({ kind: "expired" })).toBe(AUTH_MESSAGES.codeExpired);
    expect(checkCodeMessage({ kind: "too_many" })).toBe(AUTH_MESSAGES.codeTooMany);
    expect(checkCodeMessage({ kind: "invalid" })).toBe(AUTH_MESSAGES.codeIncomplete);
    expect(checkCodeMessage({ kind: "rate_limited" })).toBe(AUTH_MESSAGES.tooManyTriesWait);
  });
});

describe("the reset link", () => {
  it("reads a password reset link", () => {
    expect(readResetLink("?mode=resetPassword&oobCode=abc123&apiKey=k&lang=en")).toEqual({ kind: "reset", oobCode: "abc123" });
  });

  it("refuses other Firebase links and links without a code", () => {
    expect(readResetLink("?mode=verifyEmail&oobCode=abc")).toEqual({ kind: "wrong_mode" });
    // "Undo the email change" lands here too, so an address changed without its owner can go back.
    expect(readResetLink("?mode=recoverEmail&oobCode=abc")).toEqual({ kind: "recover", oobCode: "abc" });
    expect(readResetLink("?mode=recoverEmail")).toEqual({ kind: "bad" });
    expect(readResetLink("?mode=verifyAndChangeEmail&oobCode=abc")).toEqual({ kind: "wrong_mode" });
    expect(readResetLink("?mode=resetPassword")).toEqual({ kind: "bad" });
    expect(readResetLink("?oobCode=abc")).toEqual({ kind: "bad" });
    expect(readResetLink("?mode=&oobCode=")).toEqual({ kind: "bad" });
  });

  it("tells no link apart from a bad one: the page clears the link, so a reload has none", () => {
    expect(readResetLink("")).toEqual({ kind: "empty" });
    expect(readResetLink("?")).toEqual({ kind: "empty" });
    expect(readResetLink("?lang=en")).toEqual({ kind: "empty" });
  });
});

describe("after sign in", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns to a checked internal path, else the admin home", () => {
    expect(afterSignInPath("?next=%2Fadmin%2Fsignups%3Fpage%3D2")).toBe("/admin/signups?page=2");
    expect(afterSignInPath("?next=https://evil.example/")).toBe("/admin/signups");
    vi.stubEnv("NEXT_PUBLIC_NAV_V2_ENABLED", "true");
    expect(afterSignInPath("")).toBe("/admin");
  });
});

describe("sign-in copy", () => {
  const all = [
    ...Object.values(AUTH_MESSAGES),
    ...Object.values(AUTH_LABELS),
    codeSentMessage("alex@example.com"),
    resetSentMessage("alex@example.com"),
    resetForMessage("alex@example.com"),
    resendInMessage(28),
  ];

  it("keeps to house style: no dashes as punctuation, no AI tells", () => {
    for (const text of all) {
      expect(dashesIn(text), text).toEqual([]);
      expect(aiTellsIn(text), text).toEqual([]);
    }
  });

  it("counts down the resend wait as minutes and seconds", () => {
    expect(resendInMessage(28)).toBe("Resend code in 0:28");
    expect(resendInMessage(60)).toBe("Resend code in 1:00");
    expect(resendInMessage(4.2)).toBe("Resend code in 0:05");
    expect(resendInMessage(-3)).toBe("Resend code in 0:00");
  });
});

describe("startPasswordBotChecks", () => {
  const fakeAuth = (emulator = false) => ({ emulatorConfig: emulator ? { host: "127.0.0.1", port: 9099 } : null }) as unknown as Auth;

  it("loads the reCAPTCHA config once per page, so password calls carry a token", async () => {
    const auth = fakeAuth();
    const init = vi.fn(async () => undefined);
    startPasswordBotChecks(auth, init);
    startPasswordBotChecks(auth, init);
    expect(init).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledWith(auth);
  });

  it("never on the Auth emulator, which has no reCAPTCHA", () => {
    const init = vi.fn(async () => undefined);
    startPasswordBotChecks(fakeAuth(true), init);
    expect(init).not.toHaveBeenCalled();
  });

  it("drops a failure and tries again next time", async () => {
    const auth = fakeAuth();
    const init = vi.fn(async () => {
      throw new Error("offline");
    });
    startPasswordBotChecks(auth, init);
    await new Promise((resolve) => setImmediate(resolve));
    startPasswordBotChecks(auth, init);
    expect(init).toHaveBeenCalledTimes(2);
  });
});
