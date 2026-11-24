import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_LABELS, AUTH_MESSAGES, codeSentMessage, resendInMessage, resetSentMessage } from "@/lib/auth/messages";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
const { LoginClient } = await import("./LoginClient");
const { CodeView, CreateView, ForgotView, SignInAgainView, SignInView } = await import("./views");
const { liveMessage } = await import("./parts");
const { default: LoginPage } = await import("@/app/login/page");

/** The Google-only sign-in page exactly as it rendered before password sign-in existed. */
const TODAY = [
  "<main class=\"mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-6\">",
  "<div class=\"space-y-1 text-center\">",
  "<p class=\"text-sm font-medium uppercase tracking-widest text-neutral-500\">YouGrow</p>",
  "<h1 class=\"text-2xl font-semibold\">Admin sign in</h1>",
  "</div>",
  "<button class=\"flex w-full items-center justify-center gap-3 rounded-md border border-neutral-300 px-4 py-2.5 text-sm font-medium hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-900\">",
  "<svg width=\"18\" height=\"18\" viewBox=\"0 0 18 18\" aria-hidden=\"true\">",
  "<path fill=\"#4285F4\" d=\"M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.57 2.68-3.89 2.68-6.62Z\">",
  "</path>",
  "<path fill=\"#34A853\" d=\"M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.02-3.7H.96v2.34A9 9 0 0 0 9 18Z\">",
  "</path>",
  "<path fill=\"#FBBC05\" d=\"M3.98 10.72A5.4 5.4 0 0 1 3.7 9c0-.6.1-1.18.28-1.72V4.94H.96A9 9 0 0 0 0 9c0 1.45.35 2.82.96 4.06l3.02-2.34Z\">",
  "</path>",
  "<path fill=\"#EA4335\" d=\"M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.47.9 11.43 0 9 0A9 9 0 0 0 .96 4.94L3.98 7.28C4.68 5.16 6.66 3.58 9 3.58Z\">",
  "</path>",
  "</svg>Sign in with Google</button>",
  "<p class=\"text-center text-xs text-neutral-400\">Only accounts on this workspace&#x27;s admin list can sign in.</p>",
  "</main>",
].join("");

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el).replace(/&#x27;/g, "'");
const noop = () => undefined;
const LEGAL = { terms: "/terms", privacy: "/privacy" };

// The note under the Google button names a sign-in domain when a deployment sets one; these tests use none.
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_ADMIN_SIGNIN_DOMAIN", "");
  vi.stubEnv("NEXT_PUBLIC_ADMIN_HD", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("/login with password sign-in unavailable", () => {
  it("is today's page: the same markup, only the Google button", () => {
    const page = renderToStaticMarkup(createElement(LoginClient, { passwordSignin: false, selfServeSignup: false }));
    expect(page).toBe(TODAY);
    expect(page).not.toContain("<input");
    expect(page).not.toContain("<form");
  });
});

describe("/login with password sign-in available", () => {
  const page = html(createElement(LoginClient, { passwordSignin: true, selfServeSignup: false, legal: LEGAL }));

  it("offers Google, then the email form", () => {
    expect(page).toContain(`<h1 class="text-2xl font-semibold">${AUTH_LABELS.signInTitle}</h1>`);
    expect(page).toContain(AUTH_LABELS.google);
    expect(page.indexOf(AUTH_LABELS.google)).toBeLessThan(page.indexOf("<form"));
    expect(page).toContain('<form novalidate=""');
    expect(page).toMatch(/<input[^>]*type="email"[^>]*autoComplete="email"/);
    expect(page).toMatch(/<input[^>]*type="password"[^>]*autoComplete="current-password"/);
    expect(page).toContain(`<button type="submit"`);
    expect(page).toContain(AUTH_LABELS.forgotPassword);
    expect(page).toContain(`${AUTH_LABELS.firstTime} <button`);
    expect(page).toContain(AUTH_LABELS.createLink);
  });

  it("labels every field and the Show button, and has a live region for errors", () => {
    for (const m of page.matchAll(/<input[^>]*id="([^"]+)"/g)) {
      expect(page, m[1]).toContain(`for="${m[1]}"`);
    }
    expect(page).toContain(`aria-label="${AUTH_LABELS.showPassword}"`);
    expect(page).toContain('aria-pressed="false"');
    expect(page).toContain('aria-live="polite"');
    // A password to sign in with is never a new one: no length rule, no generator hints.
    expect(page).not.toContain("passwordrules");
  });

  it("has one live region, outside the screen, so it stays put while screens change", () => {
    expect(page.match(/aria-live=/g)).toHaveLength(1);
    expect(page).toMatch(/<\/main><div aria-live="polite" aria-atomic="true" class="sr-only"><\/div>$/);
  });

  it("sends nothing before React runs the page: the submit button starts disabled", () => {
    // Without our handler the browser would send the form itself, as a GET with the password in the URL.
    expect(page).toMatch(/<button type="submit" disabled=""[^>]*>Sign in<\/button>/);
    const create = html(
      createElement(CreateView, {
        name: "", onName: noop, email: "", onEmail: noop, password: "", onPassword: noop,
        busy: null, error: null, selfServeSignup: false, legal: LEGAL, onSubmit: noop, onSignIn: noop,
      }),
    );
    expect(create).toMatch(/<button type="submit" disabled=""/);
    // The Show button never submits, so the disabled Sign in button is the form's default button.
    expect(page).not.toMatch(/<button(?![^>]*type=)[^>]*>/);
  });
});

describe("the live region's words", () => {
  it("joins the error and the notice, and is empty with neither", () => {
    expect(liveMessage(AUTH_MESSAGES.codeRateLimited, AUTH_MESSAGES.emailNotConfirmed)).toBe(
      `${AUTH_MESSAGES.codeRateLimited} ${AUTH_MESSAGES.emailNotConfirmed}`,
    );
    expect(liveMessage(null, AUTH_MESSAGES.codeResent)).toBe(AUTH_MESSAGES.codeResent);
    expect(liveMessage(null, undefined)).toBe("");
  });

  it("isn't in the screens themselves, which mount afresh on every change of screen", () => {
    const signIn = html(
      createElement(SignInView, {
        email: "", onEmail: noop, password: "", onPassword: noop, busy: null, error: AUTH_MESSAGES.wrongPassword,
        notice: null, onGoogle: noop, onSubmit: noop, onForgot: noop, onCreate: noop,
      }),
    );
    expect(signIn).toContain(AUTH_MESSAGES.wrongPassword);
    expect(signIn).not.toContain("aria-live");
  });
});

describe("the password screens", () => {
  it("create account asks for a name, the address and a new password with the rule", () => {
    const view = html(
      createElement(CreateView, {
        name: "", onName: noop, email: "", onEmail: noop, password: "", onPassword: noop,
        busy: null, error: null, selfServeSignup: false, legal: LEGAL, onSubmit: noop, onSignIn: noop,
      }),
    );
    expect(view).toContain(AUTH_LABELS.createTitle);
    expect(view).toContain(AUTH_MESSAGES.createListedOnly);
    expect(view).toMatch(/<input[^>]*autoComplete="name"/);
    expect(view).toMatch(/<input[^>]*autoComplete="email"/);
    expect(view).toMatch(/<input[^>]*type="password"[^>]*autoComplete="new-password"[^>]*minLength="12"/);
    expect(view).toContain('passwordrules="minlength: 12;"');
    expect(view).toContain(AUTH_MESSAGES.passwordRule);
    expect(view).toContain('href="/terms"');
    expect(view).toContain('href="/privacy"');
    expect(view).toContain(`${AUTH_LABELS.agreePrefix} <a`);
  });

  it("create account leaves out pages this copy doesn't publish, and the listed only line when sign-up is open", () => {
    const view = html(
      createElement(CreateView, {
        name: "", onName: noop, email: "", onEmail: noop, password: "", onPassword: noop,
        busy: null, error: null, selfServeSignup: true, legal: { terms: null, privacy: "/privacy" }, onSubmit: noop, onSignIn: noop,
      }),
    );
    expect(view).not.toContain(AUTH_MESSAGES.createListedOnly);
    expect(view).not.toContain('href="/terms"');
    expect(view).toContain('href="/privacy"');
    const none = html(
      createElement(CreateView, {
        name: "", onName: noop, email: "", onEmail: noop, password: "", onPassword: noop,
        busy: null, error: null, selfServeSignup: false, legal: { terms: null, privacy: null }, onSubmit: noop, onSignIn: noop,
      }),
    );
    expect(none).not.toContain(AUTH_LABELS.agreePrefix);
  });

  it("disables every button while busy", () => {
    const view = html(
      createElement(CreateView, {
        name: "Alex", onName: noop, email: "alex@example.com", onEmail: noop, password: "x", onPassword: noop,
        busy: "form", error: null, selfServeSignup: false, legal: LEGAL, onSubmit: noop, onSignIn: noop,
      }),
    );
    expect(view).toContain(AUTH_LABELS.creatingAccount);
    expect(view).toMatch(/<button type="submit" disabled=""/);
    expect(view).toMatch(/<button type="button" disabled=""[^>]*>Sign in<\/button>/);
  });

  it("the code screen names the address, takes 6 digits and waits before offering another code", () => {
    const props = {
      email: "alex@example.com", code: "", onCode: noop, busy: null, error: AUTH_MESSAGES.codeWrong, notice: null,
      resendIn: 28, selfServeSignup: false, onSubmit: noop, onResend: noop, onStartAgain: noop,
    } as const;
    const view = html(createElement(CodeView, props));
    expect(view).toContain(AUTH_LABELS.codeTitle);
    expect(view).toContain(codeSentMessage("alex@example.com"));
    expect(view).toMatch(/<input[^>]*inputMode="numeric"[^>]*autoComplete="one-time-code"/);
    // No maxLength: it would cut a pasted " 123456" before its digits could be kept.
    expect(view).not.toMatch(/maxLength=/i);
    expect(view).toContain(AUTH_LABELS.confirmEmail);
    expect(view).toContain(resendInMessage(28));
    expect(view).not.toContain(`>${AUTH_LABELS.resendCode}<`);
    expect(view).toContain(AUTH_LABELS.startAgain);
    expect(view).toContain(AUTH_MESSAGES.codeHelp);
    expect(view).toMatch(/<p[^>]*>That code isn't right/);
    expect(view).not.toContain("aria-live");
    const ready = html(createElement(CodeView, { ...props, resendIn: 0, selfServeSignup: true }));
    expect(ready).toContain(`>${AUTH_LABELS.resendCode}<`);
    expect(ready).toContain(AUTH_MESSAGES.codeHelpOpen);
  });

  it("forgot password shows the same answer for any address once sent", () => {
    const view = html(
      createElement(ForgotView, {
        email: "alex@example.com", onEmail: noop, busy: null, error: null,
        notice: resetSentMessage("alex@example.com"), onSubmit: noop, onBack: noop,
      }),
    );
    expect(view).toContain(AUTH_LABELS.forgotTitle);
    expect(view).toContain(AUTH_LABELS.sendResetLink);
    expect(view).toContain(resetSentMessage("alex@example.com"));
    expect(view).toContain(AUTH_LABELS.backToSignIn);
  });

  it("sign in again explains, then goes back to sign in", () => {
    const view = html(createElement(SignInAgainView, { onContinue: noop }));
    expect(view).toContain(AUTH_MESSAGES.signInAgainTitle);
    expect(view).toContain(AUTH_MESSAGES.signInAgainBody);
    expect(view).toContain(`>${AUTH_LABELS.signIn}</button>`);
  });
});

describe("the /login page reads the switches on the server", () => {
  it("renders today's page with the switch off", () => {
    expect(renderToStaticMarkup(LoginPage())).toBe(TODAY);
  });

  it("stays on today's page with the switch on but no way to deliver a code", () => {
    vi.stubEnv("PASSWORD_SIGNIN_ENABLED", "true");
    vi.stubEnv("FIREBASE_AUTH_EMULATOR_HOST", "");
    vi.stubEnv("MANDRILL_API_KEY", "");
    vi.stubEnv("RESEND_API_KEY", "");
    expect(renderToStaticMarkup(LoginPage())).toBe(TODAY);
  });

  it("offers the email form once the switch is on and a code can be delivered", () => {
    vi.stubEnv("PASSWORD_SIGNIN_ENABLED", "true");
    vi.stubEnv("FIREBASE_AUTH_EMULATOR_HOST", "127.0.0.1:9099");
    const page = renderToStaticMarkup(LoginPage());
    expect(page).toContain('autoComplete="current-password"');
    expect(page).toContain(AUTH_LABELS.google);
  });
});
