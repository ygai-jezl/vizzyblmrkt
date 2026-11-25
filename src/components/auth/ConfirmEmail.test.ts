import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_LABELS, AUTH_MESSAGES } from "@/lib/auth/messages";
import { WORKSPACE_NOT_SET_UP_MESSAGE } from "@/lib/auth/accessDenied";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
const { ConfirmEmailView, confirmLinkStop, linkCheckPhase, mintPhase, reloadOnNewLink, takeConfirmLink } = await import("./ConfirmEmail");
type ConfirmPhase = Parameters<typeof ConfirmEmailView>[0]["phase"];
const { default: ConfirmEmailPage, dynamic, metadata } = await import("@/app/login/confirm/page");

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el).replace(/&#x27;/g, "'");
const view = (phase: ConfirmPhase) => html(createElement(ConfirmEmailView, { phase, onSignIn: async () => null }));
const TOKEN = "Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_ADMIN_SIGNIN_DOMAIN", "");
  vi.stubEnv("NEXT_PUBLIC_ADMIN_HD", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("/login/confirm", () => {
  it("is never indexed and never sends the page on as a referrer", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.referrer).toBe("no-referrer");
    expect(dynamic).toBe("force-dynamic");
  });

  it("says password sign-in is off while it is unavailable", () => {
    vi.stubEnv("PASSWORD_SIGNIN_ENABLED", "");
    const page = html(ConfirmEmailPage());
    expect(page).toContain(AUTH_MESSAGES.passwordSigninOff);
    expect(page).toContain('href="/login"');
    expect(page).not.toContain("<input");
    // On, but with no way to deliver email: still off.
    vi.stubEnv("PASSWORD_SIGNIN_ENABLED", "true");
    vi.stubEnv("FIREBASE_AUTH_EMULATOR_HOST", "");
    vi.stubEnv("MANDRILL_API_KEY", "");
    vi.stubEnv("RESEND_API_KEY", "");
    expect(html(ConfirmEmailPage())).toContain(AUTH_MESSAGES.passwordSigninOff);
  });

  it("confirms first while it is available, with one live region", () => {
    vi.stubEnv("PASSWORD_SIGNIN_ENABLED", "true");
    vi.stubEnv("FIREBASE_AUTH_EMULATOR_HOST", "127.0.0.1:9099");
    const page = html(ConfirmEmailPage());
    expect(page).toContain(`<h1 class="text-2xl font-semibold">${AUTH_LABELS.confirmTitle}</h1>`);
    expect(page).toContain(AUTH_LABELS.confirming);
    expect(page).not.toContain(AUTH_MESSAGES.passwordSigninOff);
    expect(page.match(/aria-live=/g)).toHaveLength(1);
    expect(page).toMatch(/<\/main><div aria-live="polite" aria-atomic="true" class="sr-only">[^<]*<\/div>$/);
  });
});

describe("taking the link", () => {
  const fakeWindow = (hash: string) => {
    const replaceState = vi.fn();
    return { win: { location: { hash, pathname: "/login/confirm" }, history: { replaceState } }, replaceState };
  };

  it("reads the token from the fragment, then clears it from the address bar", () => {
    const { win, replaceState } = fakeWindow(`#t=${TOKEN}`);
    expect(takeConfirmLink(win)).toEqual({ kind: "link", token: TOKEN });
    expect(replaceState).toHaveBeenCalledWith(null, "", "/login/confirm");
  });

  it("clears links it can't use too, and after a reload says to open the email's link again", () => {
    const bad = fakeWindow("#t=short");
    expect(takeConfirmLink(bad.win)).toEqual({ kind: "bad" });
    expect(bad.replaceState).toHaveBeenCalledWith(null, "", "/login/confirm");
    expect(confirmLinkStop({ kind: "bad" })).toEqual({ kind: "stopped", message: AUTH_MESSAGES.linkInvalid });
    const empty = fakeWindow("");
    expect(takeConfirmLink(empty.win)).toEqual({ kind: "empty" });
    expect(confirmLinkStop({ kind: "empty" })).toEqual({ kind: "stopped", message: AUTH_MESSAGES.linkReopen });
  });

  it("reloads when another link is pasted into the open tab, so it is read and cleared like the first", () => {
    // Pasting /login/confirm#t=... into this tab only changes the fragment: nothing reloads by itself.
    const listeners: Array<() => void> = [];
    const reload = vi.fn();
    const win = {
      location: { hash: "", reload },
      addEventListener: vi.fn((_: "hashchange", l: () => void) => void listeners.push(l)),
      removeEventListener: vi.fn(),
    };
    const stop = reloadOnNewLink(win);
    expect(win.addEventListener).toHaveBeenCalledWith("hashchange", expect.any(Function));
    // A fragment that went away (or a bare "#") is nothing to read.
    win.location.hash = "#";
    listeners.forEach((l) => l());
    expect(reload).not.toHaveBeenCalled();
    win.location.hash = `#t=${TOKEN}`;
    listeners.forEach((l) => l());
    expect(reload).toHaveBeenCalledTimes(1);
    stop();
    expect(win.removeEventListener).toHaveBeenCalledWith("hashchange", listeners[0]);
  });
});

describe("what the page does next", () => {
  it("after the server refuses the link", () => {
    expect(linkCheckPhase({ kind: "invalid" })).toEqual({ kind: "stopped", message: AUTH_MESSAGES.linkInvalid });
    // Signed in with Google, or the sign-in lapsed: ask for the password, keeping the link.
    expect(linkCheckPhase({ kind: "sign_in" })).toEqual({ kind: "sign_in" });
    expect(linkCheckPhase({ kind: "rate_limited" })).toEqual({ kind: "retry", message: AUTH_MESSAGES.tooManyTriesWait });
    expect(linkCheckPhase({ kind: "unavailable" })).toEqual({ kind: "stopped", message: AUTH_MESSAGES.passwordUnavailable });
    expect(linkCheckPhase({ kind: "error" })).toEqual({ kind: "retry", message: AUTH_MESSAGES.somethingWentWrong });
  });

  it("with each of the door's answers, as on /login", () => {
    expect(mintPhase("ok")).toEqual({ kind: "leaving" });
    expect(mintPhase("forbidden")).toMatchObject({ kind: "stopped", message: expect.stringContaining("Access denied") });
    expect(mintPhase("not_set_up")).toEqual({ kind: "stopped", message: WORKSPACE_NOT_SET_UP_MESSAGE });
    expect(mintPhase("google_only")).toEqual({ kind: "stopped", message: AUTH_MESSAGES.googleOnly });
    expect(mintPhase("sign_in_again")).toEqual({ kind: "sign_in_again" });
    expect(mintPhase("address_updated")).toEqual({ kind: "stopped", message: AUTH_MESSAGES.googleAddressChanged });
    expect(mintPhase("email_not_verified")).toEqual({ kind: "retry", message: AUTH_MESSAGES.somethingWentWrong });
    expect(mintPhase("error")).toEqual({ kind: "retry", message: AUTH_MESSAGES.somethingWentWrong });
  });
});

describe("the confirm screens", () => {
  it("asks a browser that isn't signed in for the email and password", () => {
    const page = view({ kind: "sign_in" });
    expect(page).toContain(AUTH_LABELS.confirmTitle);
    expect(page).toContain(AUTH_MESSAGES.confirmSignIn);
    expect(page).toContain('<form novalidate=""');
    expect(page).toMatch(/<input[^>]*type="email"[^>]*autoComplete="email"/);
    expect(page).toMatch(/<input[^>]*type="password"[^>]*autoComplete="current-password"/);
    expect(page).not.toContain("passwordrules");
    // Nothing goes out before React runs the page: the browser would send the form as a GET.
    expect(page).toMatch(/<button type="submit" disabled=""[^>]*>Sign in<\/button>/);
    expect(page).not.toMatch(/<button(?![^>]*type=)[^>]*>/);
    for (const m of page.matchAll(/<input[^>]*id="([^"]+)"/g)) expect(page, m[1]).toContain(`for="${m[1]}"`);
    expect(page.match(/aria-live=/g)).toHaveLength(1);
  });

  it("disables the form only while the sign-in phase says it is busy, so it never comes back stuck", () => {
    const busy = view({ kind: "sign_in", busy: true });
    expect(busy).toMatch(/<input[^>]*type="email"[^>]*disabled=""/);
    expect(busy).toMatch(/<input[^>]*type="password"[^>]*disabled=""/);
    expect(busy).toMatch(/<button type="submit" disabled=""[^>]*>Signing in…<\/button>/);
    // Back to sign in (a lapsed sign-in, or Try again with the browser signed out): ready to type.
    const again = view({ kind: "sign_in" });
    expect(again).not.toMatch(/<input[^>]*disabled=""/);
    expect(again).toMatch(/>Sign in<\/button>/);
    expect(linkCheckPhase({ kind: "sign_in" })).not.toHaveProperty("busy");
  });

  it("says a link it can't use can't be used, with a way back to sign in", () => {
    const page = view({ kind: "stopped", message: AUTH_MESSAGES.linkInvalid });
    expect(page).toContain(AUTH_MESSAGES.linkInvalid);
    expect(page).toContain(`href="/login"`);
    expect(page).toContain(AUTH_LABELS.backToSignIn);
    expect(page).not.toContain("<input");
  });

  it("offers to try again after a failure, with the button waiting for React", () => {
    const page = view({ kind: "retry", message: AUTH_MESSAGES.somethingWentWrong });
    expect(page).toContain(AUTH_MESSAGES.somethingWentWrong);
    expect(page).toMatch(/<button type="button" disabled=""[^>]*>Try again<\/button>/);
    expect(page).toContain(`href="/login"`);
  });

  it("explains sign in again, and shows progress while confirming and leaving", () => {
    const again = view({ kind: "sign_in_again" });
    expect(again).toContain(AUTH_MESSAGES.signInAgainTitle);
    expect(again).toContain(AUTH_MESSAGES.signInAgainBody);
    expect(view({ kind: "checking" })).toContain(AUTH_LABELS.confirming);
    expect(view({ kind: "leaving" })).toContain(AUTH_LABELS.signingIn);
  });

  it("reads each phase's words out through the one live region", () => {
    const live = (phase: ConfirmPhase) => /<div aria-live="polite" aria-atomic="true" class="sr-only">([^<]*)<\/div>$/.exec(view(phase))![1];
    expect(live({ kind: "checking" })).toBe(AUTH_LABELS.confirming);
    expect(live({ kind: "sign_in" })).toBe(AUTH_MESSAGES.confirmSignIn);
    expect(live({ kind: "stopped", message: AUTH_MESSAGES.linkInvalid })).toBe(AUTH_MESSAGES.linkInvalid);
    expect(live({ kind: "sign_in_again" })).toBe(AUTH_MESSAGES.signInAgainBody);
  });
});
