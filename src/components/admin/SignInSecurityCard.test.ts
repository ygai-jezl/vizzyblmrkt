import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { User } from "firebase/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { AUTH_LABELS, AUTH_MESSAGES } from "@/lib/auth/messages";

const fb = vi.hoisted(() => ({
  reauthenticateWithCredential: vi.fn(),
  updatePassword: vi.fn(),
  signOut: vi.fn(),
  onAuthStateChanged: vi.fn(),
  validatePassword: vi.fn(),
  credential: vi.fn((email: string, password: string) => ({ providerId: "password", email, password })),
}));
const session = vi.hoisted(() => ({ mintSession: vi.fn(), refreshSession: vi.fn(), safeNextPath: vi.fn() }));
const CLIENT_AUTH = vi.hoisted(() => ({ name: "client-auth" }));

vi.mock("firebase/auth", () => ({
  EmailAuthProvider: { credential: fb.credential },
  onAuthStateChanged: fb.onAuthStateChanged,
  reauthenticateWithCredential: fb.reauthenticateWithCredential,
  signOut: fb.signOut,
  updatePassword: fb.updatePassword,
  validatePassword: fb.validatePassword,
}));
vi.mock("@/lib/auth/firebaseClient", () => ({ getClientAuth: () => CLIENT_AUTH }));
vi.mock("@/lib/auth/clientSession", () => session);

const {
  ChangePasswordForm,
  SIGN_IN_SECURITY_COPY: COPY,
  SIGN_OUT_EVERYWHERE_URL,
  SignInSecurity,
  SignInSecurityCard,
  SignOutEverywhereConfirm,
  changePassword,
  changePasswordMessage,
  hasPasswordSignIn,
  signInMethods,
  signOutEverywhere,
} = await import("./SignInSecurityCard");

/** A made-up browser user with these sign-in methods. */
function fakeUser(providers: string[], email: string | null = "alex@example.com"): User {
  return {
    uid: "uid_alex",
    email,
    providerData: providers.map((providerId) => ({ providerId, email, uid: `${providerId}:alex` })),
  } as unknown as User;
}

const html = (el: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(el).replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fb.reauthenticateWithCredential.mockResolvedValue({});
  fb.updatePassword.mockResolvedValue(undefined);
  fb.signOut.mockResolvedValue(undefined);
  fb.validatePassword.mockResolvedValue({ isValid: true, meetsMinPasswordLength: true });
  session.mintSession.mockResolvedValue("ok");
  session.refreshSession.mockResolvedValue(false);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  fetchMock.mockReset();
});

describe("How you sign in", () => {
  it("shows Password first, then Google, each once, and any other method by its id", () => {
    expect(signInMethods([{ providerId: "google.com" }, { providerId: "password" }])).toEqual(["Password", "Google"]);
    expect(signInMethods([{ providerId: "google.com" }, { providerId: "google.com" }])).toEqual(["Google"]);
    expect(signInMethods([{ providerId: "example.test" }, { providerId: "google.com" }])).toEqual(["Google", "example.test"]);
    expect(signInMethods([])).toEqual([]);
  });

  it("offers Change password only to accounts with a password", () => {
    expect(hasPasswordSignIn(fakeUser(["password"]))).toBe(true);
    expect(hasPasswordSignIn(fakeUser(["google.com", "password"]))).toBe(true);
    expect(hasPasswordSignIn(fakeUser(["google.com"]))).toBe(false);
  });
});

describe("the card", () => {
  it("shows a password account's methods as chips, Change password and Sign out everywhere, each with its line", () => {
    const out = html(createElement(SignInSecurity, { user: fakeUser(["google.com", "password"]) }));
    expect(out).toContain(`<h2 id="`);
    expect(out).toContain(COPY.title);
    expect(out).toMatch(/<li[^>]*>Password<\/li><li[^>]*>Google<\/li>/);
    expect(out).toContain(`>${COPY.changePassword}</button>`);
    expect(out).toContain(COPY.passwordNote);
    expect(out).toContain(`>${COPY.signOutEverywhere}</button>`);
    expect(out).toContain(COPY.devicesNote);
    // The form opens only on click.
    expect(out).not.toContain('type="password"');
    // A live region is there from the start, so "Password changed" is read out when it arrives.
    expect(out).toContain('<div aria-live="polite" aria-atomic="true" class="sr-only"></div>');
  });

  it("uses the same neutral colours as the other Settings cards, which work with or without the new navigation", () => {
    const out = html(createElement(SignInSecurity, { user: fakeUser(["google.com", "password"]) }));
    expect(out).not.toMatch(/(?:bg|text|border|divide)-shell-/);
    expect(out).toContain("border-neutral-200");
  });

  it("has no Change password for a Google account, and still signs out everywhere", () => {
    const out = html(createElement(SignInSecurity, { user: fakeUser(["google.com"]) }));
    expect(out).toMatch(/<li[^>]*>Google<\/li>/);
    expect(out).not.toContain(COPY.changePassword);
    expect(out).not.toContain(COPY.passwordNote);
    expect(out).toContain(COPY.signOutEverywhere);
  });

  it("says Loading while the browser's sign-in loads, and how to see it when there is none", () => {
    const loading = html(createElement(SignInSecurity, { user: undefined }));
    expect(loading).toContain(COPY.loading);
    expect(loading).not.toContain(COPY.changePassword);
    expect(loading).toContain(COPY.signOutEverywhere);

    const none = html(createElement(SignInSecurity, { user: null }));
    expect(none).toContain(COPY.signInAgainToSee);
    expect(none).not.toContain(COPY.changePassword);
    expect(none).toContain(COPY.signOutEverywhere);
  });

  it("renders on the server before the browser's sign-in is known", () => {
    const out = html(createElement(SignInSecurityCard));
    expect(out).toContain(COPY.title);
    expect(out).toContain(COPY.loading);
    expect(fb.onAuthStateChanged).not.toHaveBeenCalled();
  });

  it("asks for the current and new password, each hidden with Show, with the 12 character rule", () => {
    const out = html(createElement(ChangePasswordForm, { user: fakeUser(["password"]), onDone: () => {}, onCancel: () => {} }));
    expect(out.match(/type="password"/g)).toHaveLength(2);
    expect(out).toMatch(/name="password" type="password" autoComplete="current-password"/);
    expect(out).toMatch(/name="new-password" type="password" autoComplete="new-password"/);
    expect(out).toContain('minLength="12"');
    expect(out).toContain('passwordrules="minlength: 12;"');
    expect(out).toContain(AUTH_MESSAGES.passwordRule);
    expect(out).toContain(`>${COPY.currentPassword}</label>`);
    expect(out).toContain(`>${AUTH_LABELS.newPassword}</label>`);
    expect(out.match(/aria-pressed="false"[^>]*>Show<\/button>/g)).toHaveLength(2);
    // The hidden username lets a password manager file the new password under this account.
    expect(out).toMatch(/<input type="email" name="username" autoComplete="username"[^>]*value="alex@example.com"/);
    // Save stays off until both are typed; the browser's own checks give way to our messages.
    expect(out).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Save password<\/button>/);
    expect(out).toMatch(/<form novalidate=""/);
    expect(out).toContain(`>${COPY.cancel}</button>`);
  });
});

describe("changePassword", () => {
  it("checks the current password, saves the new one, then keeps this tab signed in", async () => {
    const user = fakeUser(["password"]);
    const out = await changePassword(user, "old password 123", "a brand new passphrase");
    expect(out).toEqual({ ok: true, message: AUTH_MESSAGES.passwordChanged });
    expect(fb.credential).toHaveBeenCalledWith("alex@example.com", "old password 123");
    expect(fb.reauthenticateWithCredential).toHaveBeenCalledWith(user, {
      providerId: "password",
      email: "alex@example.com",
      password: "old password 123",
    });
    expect(fb.updatePassword).toHaveBeenCalledWith(user, "a brand new passphrase");
    expect(session.mintSession).toHaveBeenCalledWith(user);
    expect(fb.validatePassword).toHaveBeenCalledWith(CLIENT_AUTH, "a brand new passphrase");
    const order = (fn: { mock: { invocationCallOrder: number[] } }, call = 0) => fn.mock.invocationCallOrder[call]!;
    expect(order(fb.reauthenticateWithCredential)).toBeLessThan(order(fb.updatePassword));
    // Then a sign-in with the new password, so the token the door gets is from after the change.
    expect(fb.reauthenticateWithCredential).toHaveBeenCalledTimes(2);
    expect(fb.reauthenticateWithCredential).toHaveBeenLastCalledWith(user, {
      providerId: "password",
      email: "alex@example.com",
      password: "a brand new passphrase",
    });
    expect(order(fb.updatePassword)).toBeLessThan(order(fb.reauthenticateWithCredential, 1));
    expect(order(fb.reauthenticateWithCredential, 1)).toBeLessThan(order(session.mintSession));
    // The password goes to Identity Platform only: nothing of ours is called with it.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("turns down a new password under 12 characters before asking anyone", async () => {
    const out = await changePassword(fakeUser(["password"]), "old password 123", "elevenchars");
    expect(out).toEqual({ ok: false, message: AUTH_MESSAGES.passwordTooShort });
    expect(fb.reauthenticateWithCredential).not.toHaveBeenCalled();
    expect(fb.updatePassword).not.toHaveBeenCalled();
  });

  it("turns down a new password the project's password policy refuses, before checking the current one", async () => {
    fb.validatePassword.mockResolvedValueOnce({ isValid: false, meetsMinPasswordLength: true });
    const out = await changePassword(fakeUser(["password"]), "old password 123", "aaaaaaaaaaaaaaaa");
    expect(out).toEqual({ ok: false, message: AUTH_MESSAGES.passwordRulesNotMet });
    expect(fb.reauthenticateWithCredential).not.toHaveBeenCalled();
  });

  it("says the current password is wrong when it is, or missing, and changes nothing", async () => {
    for (const code of ["auth/wrong-password", "auth/invalid-credential", "auth/invalid-login-credentials"]) {
      fb.reauthenticateWithCredential.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
      const out = await changePassword(fakeUser(["password"]), "not it at all", "a brand new passphrase");
      expect(out, code).toEqual({ ok: false, message: AUTH_MESSAGES.currentPasswordWrong });
    }
    expect(await changePassword(fakeUser(["password"]), "", "a brand new passphrase")).toEqual({
      ok: false,
      message: AUTH_MESSAGES.currentPasswordWrong,
    });
    expect(fb.updatePassword).not.toHaveBeenCalled();
    expect(session.mintSession).not.toHaveBeenCalled();
  });

  it("says to wait after too many tries", async () => {
    fb.reauthenticateWithCredential.mockRejectedValueOnce({ code: "auth/too-many-requests" });
    expect(await changePassword(fakeUser(["password"]), "old password 123", "a brand new passphrase")).toEqual({
      ok: false,
      message: AUTH_MESSAGES.tooManyTries,
    });
  });

  it("explains why the new password was turned down on save, and a plain retry otherwise", async () => {
    const cases: Array<[string, string]> = [
      ["auth/weak-password", AUTH_MESSAGES.passwordTooShort],
      ["auth/password-does-not-meet-requirements", AUTH_MESSAGES.passwordRulesNotMet],
      ["auth/user-disabled", AUTH_MESSAGES.accountDisabled],
      ["auth/network-request-failed", AUTH_MESSAGES.somethingWentWrong],
    ];
    for (const [code, message] of cases) {
      fb.updatePassword.mockRejectedValueOnce({ code });
      const out = await changePassword(fakeUser(["password"]), "old password 123", "a brand new passphrase");
      expect(out, code).toEqual({ ok: false, message });
    }
    expect(session.mintSession).not.toHaveBeenCalled();
  });

  it("says the password changed and to sign in again when this tab's new session couldn't be made", async () => {
    const want = { ok: true, message: AUTH_MESSAGES.passwordChangedSignInAgain };
    session.mintSession.mockRejectedValueOnce(new Error("offline"));
    expect(await changePassword(fakeUser(["password"]), "old password 123", "a brand new passphrase")).toEqual(want);
    // The door refused the token (401): never "Password changed" alone.
    session.mintSession.mockResolvedValueOnce("error");
    expect(await changePassword(fakeUser(["password"]), "old password 123", "a brand new passphrase")).toEqual(want);
    // The sign-in with the new password failed.
    fb.reauthenticateWithCredential.mockResolvedValueOnce({}).mockRejectedValueOnce({ code: "auth/network-request-failed" });
    expect(await changePassword(fakeUser(["password"]), "old password 123", "a brand new passphrase")).toEqual(want);
  });

  it("says to sign in again with Google when the team's domain lets this address in with Google only", async () => {
    session.mintSession.mockResolvedValueOnce("google_only");
    expect(await changePassword(fakeUser(["password", "google.com"]), "old password 123", "a brand new passphrase")).toEqual({
      ok: true,
      message: AUTH_MESSAGES.passwordChangedUseGoogle,
    });
  });

  it("asks to try again when the account has no address to check the password against", async () => {
    const out = await changePassword(fakeUser(["password"], null), "old password 123", "a brand new passphrase");
    expect(out).toEqual({ ok: false, message: AUTH_MESSAGES.somethingWentWrong });
    expect(fb.reauthenticateWithCredential).not.toHaveBeenCalled();
  });

  it("maps every other code, or none, to a plain retry", () => {
    expect(changePasswordMessage(null)).toBe(AUTH_MESSAGES.somethingWentWrong);
    expect(changePasswordMessage("auth/requires-recent-login")).toBe(AUTH_MESSAGES.somethingWentWrong);
    expect(changePasswordMessage("auth/user-mismatch")).toBe(AUTH_MESSAGES.somethingWentWrong);
  });
});

describe("Sign out everywhere asks first", () => {
  const noop = () => {};
  it("shows only the button at first: nothing is revoked on the first click", () => {
    const out = html(createElement(SignInSecurity, { user: fakeUser(["password"]) }));
    expect(out).toContain(`>${COPY.signOutEverywhere}</button>`);
    expect(out).not.toContain(COPY.signOutEverywhereConfirm);
  });

  it("then asks, with Yes and Cancel, in the card rather than a browser dialog", () => {
    const out = html(createElement(SignOutEverywhereConfirm, { leaving: false, onYes: noop, onCancel: noop }));
    expect(out).toContain(COPY.signOutEverywhereConfirm);
    expect(out).toContain(`>${COPY.signOutEverywhereYes}</button>`);
    expect(out).toContain(`>${COPY.cancel}</button>`);
    expect(out).toContain('role="group"');
  });

  it("says it is signing out, with both buttons disabled, while it works", () => {
    const out = html(createElement(SignOutEverywhereConfirm, { leaving: true, onYes: noop, onCancel: noop }));
    expect(out).toContain(COPY.signingOut);
    expect(out.match(/disabled=""/g)).toHaveLength(2);
  });
});

describe("signOutEverywhere", () => {
  const answer = (status: number) => new Response(JSON.stringify(status === 200 ? { ok: true } : { error: "x" }), { status });

  it("revokes every sign-in on the server, then signs this browser out", async () => {
    fetchMock.mockResolvedValueOnce(answer(200));
    expect(await signOutEverywhere()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(SIGN_OUT_EVERYWHERE_URL, { method: "DELETE" });
    expect(SIGN_OUT_EVERYWHERE_URL).toBe("/api/auth/session?scope=everywhere");
    expect(fb.signOut).toHaveBeenCalledWith(CLIENT_AUTH);
    expect(fetchMock.mock.invocationCallOrder[0]!).toBeLessThan(fb.signOut.mock.invocationCallOrder[0]!);
  });

  it("stays signed in and reports failure when the server didn't revoke", async () => {
    fetchMock.mockResolvedValueOnce(answer(500));
    expect(await signOutEverywhere()).toBe(false);
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    expect(await signOutEverywhere()).toBe(false);
    expect(fb.signOut).not.toHaveBeenCalled();
    expect(session.refreshSession).not.toHaveBeenCalled();
  });

  it("mints a lapsed session again from this browser and tries once more", async () => {
    session.refreshSession.mockResolvedValueOnce(true);
    fetchMock.mockResolvedValueOnce(answer(401)).mockResolvedValueOnce(answer(200));
    expect(await signOutEverywhere()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fb.signOut).toHaveBeenCalledTimes(1);
  });

  it("gives up on a lapsed session it can't mint again", async () => {
    fetchMock.mockResolvedValueOnce(answer(401));
    expect(await signOutEverywhere()).toBe(false);
    expect(session.refreshSession).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fb.signOut).not.toHaveBeenCalled();
  });

  it("counts as done when the server revoked but this browser's sign out failed", async () => {
    fetchMock.mockResolvedValueOnce(answer(200));
    fb.signOut.mockRejectedValueOnce(new Error("no client"));
    expect(await signOutEverywhere()).toBe(true);
  });
});

describe("copy", () => {
  it("keeps to the writing rules", () => {
    for (const [key, text] of Object.entries(COPY)) {
      expect(dashesIn(text), key).toEqual([]);
      expect(aiTellsIn(text), key).toEqual([]);
    }
  });

  it("says what each action does, as the plan's mockup does", () => {
    expect(COPY.passwordNote).toBe("Changing it signs you out on your other devices.");
    expect(COPY.devicesNote).toBe("Signs out everywhere, including here.");
  });
});
