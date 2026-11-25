import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_LABELS, AUTH_MESSAGES, recoverDoneMessage, resetForMessage, resetSentMessage } from "@/lib/auth/messages";
import { ResetPasswordView, recoverCheckFailed, resetCheckFailed, resetLinkStop, takeResetLink, type ResetPhase } from "./ResetPassword";
import ResetPasswordPage, { dynamic, metadata } from "@/app/auth/reset/page";

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el).replace(/&#x27;/g, "'");
const view = (phase: ResetPhase) => html(createElement(ResetPasswordView, { phase, onSave: async () => null }));

describe("/auth/reset", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is never indexed and never sends the link on as a referrer", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.referrer).toBe("no-referrer");
    expect(dynamic).toBe("force-dynamic");
  });

  it("says password sign-in is off while the switch is off", () => {
    const page = html(ResetPasswordPage());
    expect(page).toContain(AUTH_MESSAGES.passwordSigninOff);
    expect(page).toContain('href="/login"');
    expect(page).not.toContain("<input");
  });

  it("checks the link first while the switch is on", () => {
    vi.stubEnv("PASSWORD_SIGNIN_ENABLED", "true");
    const page = html(ResetPasswordPage());
    expect(page).toContain(AUTH_LABELS.checkingLink);
    expect(page).not.toContain(AUTH_MESSAGES.passwordSigninOff);
  });
});

describe("taking the reset link", () => {
  const fakeWindow = (search: string) => {
    const replaceState = vi.fn();
    return { win: { location: { search, pathname: "/auth/reset" }, history: { replaceState } }, replaceState };
  };

  it("reads the code, then clears the query from the address bar", () => {
    const { win, replaceState } = fakeWindow("?mode=resetPassword&oobCode=one-time&apiKey=k");
    expect(takeResetLink(win)).toEqual({ kind: "reset", oobCode: "one-time" });
    expect(replaceState).toHaveBeenCalledWith(null, "", "/auth/reset");
  });

  it("after a reload, says to open the email's link again, not that the link is used up", () => {
    // The first load cleared the query, so a reload finds none, while the link in the email still works.
    const { win } = fakeWindow("");
    const link = takeResetLink(win);
    expect(link).toEqual({ kind: "empty" });
    expect(resetLinkStop(link as { kind: "empty" })).toEqual({ kind: "stopped", message: AUTH_MESSAGES.resetLinkReopen });
    expect(resetLinkStop({ kind: "bad" })).toEqual({ kind: "stopped", message: AUTH_MESSAGES.resetLinkBad });
    expect(resetLinkStop({ kind: "wrong_mode" })).toEqual({ kind: "stopped", message: AUTH_MESSAGES.resetLinkWrongMode });
  });

  it("offers to check again after a network failure, and stops only for a link Firebase refuses", () => {
    const err = (code: string) => Object.assign(new Error(code), { code });
    expect(resetCheckFailed(err("auth/network-request-failed"))).toEqual({ kind: "retry", message: AUTH_MESSAGES.somethingWentWrong });
    for (const code of ["auth/expired-action-code", "auth/invalid-action-code", "auth/user-not-found"]) {
      expect(resetCheckFailed(err(code)), code).toEqual({ kind: "stopped", message: AUTH_MESSAGES.resetLinkBad });
    }
  });

  it("clears the query for links it can't use too", () => {
    const { win, replaceState } = fakeWindow("?mode=verifyEmail&oobCode=one-time");
    expect(takeResetLink(win)).toEqual({ kind: "wrong_mode" });
    expect(replaceState).toHaveBeenCalledWith(null, "", "/auth/reset");
  });
});

describe("the reset screens", () => {
  it("asks for a new password for the link's address", () => {
    const page = view({ kind: "form", email: "alex@example.com" });
    expect(page).toContain(AUTH_LABELS.resetTitle);
    expect(page).toContain(resetForMessage("alex@example.com"));
    // A hidden username lets the password manager save the new password against the right account.
    expect(page).toMatch(/<input type="email" name="email" autoComplete="username" readonly="" hidden="" value="alex@example.com"\/>/);
    expect(page).toMatch(/<input[^>]*type="password"[^>]*autoComplete="new-password"/);
    expect(page).toContain('passwordrules="minlength: 12;"');
    expect(page).toContain(`aria-label="${AUTH_LABELS.showPassword}"`);
    expect(page).toContain(AUTH_MESSAGES.passwordRule);
    expect(page).toContain(AUTH_LABELS.savePassword);
    expect(page).toContain(AUTH_MESSAGES.resetLinkOnce);
    expect(page).toContain('aria-live="polite"');
    // A way back if saving fails.
    expect(page).toContain(`href="/login"`);
    expect(page).toContain(`>${AUTH_LABELS.backToSignIn}</a>`);
    // Nothing is sent before React runs the page.
    expect(page).toMatch(/<button type="submit" disabled=""/);
  });

  it("reads out each phase's message from one live region outside the screens", () => {
    const live = (message: string) => `</main><div aria-live="polite" aria-atomic="true" class="sr-only">${message}</div>`;
    expect(view({ kind: "checking" })).toContain(live(AUTH_LABELS.checkingLink));
    expect(view({ kind: "done" })).toContain(live(AUTH_MESSAGES.resetDone));
    expect(view({ kind: "stopped", message: AUTH_MESSAGES.resetLinkBad })).toContain(live(AUTH_MESSAGES.resetLinkBad));
    expect(view({ kind: "form", email: "alex@example.com" })).toContain(live(""));
    for (const phase of [{ kind: "checking" }, { kind: "done" }, { kind: "form", email: "alex@example.com" }] as const) {
      expect(view(phase).match(/aria-live=|role="status"/g), phase.kind).toHaveLength(1);
    }
  });

  it("after a network failure, offers Try again that checks the same link, and a way back", () => {
    const onRetry = vi.fn();
    const el = createElement(ResetPasswordView, { phase: { kind: "retry", message: AUTH_MESSAGES.somethingWentWrong }, onSave: async () => null, onRetry });
    const page = html(el);
    expect(page).toContain(AUTH_MESSAGES.somethingWentWrong);
    expect(page).toMatch(new RegExp(`<button type="button"[^>]*>${AUTH_LABELS.tryAgain}</button>`));
    expect(page).toContain(`>${AUTH_LABELS.backToSignIn}</a>`);
    expect(page).not.toContain("<input");
    expect(page.match(/aria-live=|role="status"/g)).toHaveLength(1);
  });

  it("says the password is saved, with a way to sign in", () => {
    const page = view({ kind: "done" });
    expect(page).toContain(AUTH_MESSAGES.resetDone);
    expect(page).toContain(`href="/login"`);
    expect(page).toContain(`>${AUTH_LABELS.signIn}</a>`);
  });

  it("explains a link it can't use, with a way back", () => {
    for (const message of [AUTH_MESSAGES.resetLinkBad, AUTH_MESSAGES.resetLinkWrongMode, AUTH_MESSAGES.resetLinkReopen]) {
      const page = view({ kind: "stopped", message });
      expect(page).toContain(message);
      expect(page).toContain(`>${AUTH_LABELS.backToSignIn}</a>`);
      expect(page).not.toContain("<input");
    }
  });
});

describe("an undo the email change link", () => {
  const email = "alex@example.com";
  const withSend = (phase: ResetPhase) =>
    html(createElement(ResetPasswordView, { phase, onSave: async () => null, onSendReset: async () => null }));

  it("says the address is back, advises a reset, and offers one while password sign-in is on", () => {
    const out = withSend({ kind: "recovered", email, sent: false });
    expect(out).toContain(AUTH_LABELS.recoverTitle);
    expect(out).toContain(recoverDoneMessage(email));
    expect(out).toContain(AUTH_MESSAGES.recoverAdvice);
    expect(out).toContain(`>${AUTH_LABELS.sendResetLink}</button>`);
    expect(out).toContain(`<div aria-live="polite" aria-atomic="true" class="sr-only">${recoverDoneMessage(email)}</div>`);
  });

  it("offers no reset button while password sign-in is off", () => {
    expect(view({ kind: "recovered", email, sent: false })).not.toContain(AUTH_LABELS.sendResetLink);
  });

  it("says the reset link is on its way once sent", () => {
    const out = withSend({ kind: "recovered", email, sent: true });
    expect(out).toContain(resetSentMessage(email));
    expect(out).not.toContain(`>${AUTH_LABELS.sendResetLink}</button>`);
  });

  it("lets a network failure be tried again, and explains a used or expired link", () => {
    expect(recoverCheckFailed({ code: "auth/network-request-failed" })).toEqual({ kind: "retry", message: AUTH_MESSAGES.somethingWentWrong });
    expect(recoverCheckFailed({ code: "auth/invalid-action-code" })).toEqual({ kind: "stopped", message: AUTH_MESSAGES.recoverLinkBad });
  });

  it("takes the link out of the address bar like a reset link", () => {
    const replaceState = vi.fn();
    const win = { location: { search: "?mode=recoverEmail&oobCode=one-time", pathname: "/auth/reset" }, history: { replaceState } };
    expect(takeResetLink(win)).toEqual({ kind: "recover", oobCode: "one-time" });
    expect(replaceState).toHaveBeenCalledWith(null, "", "/auth/reset");
  });
});
