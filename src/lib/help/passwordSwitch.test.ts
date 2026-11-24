import { afterEach, describe, expect, it, vi } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { AUTH_LABELS, AUTH_MESSAGES, SIGN_IN_SECURITY_COPY } from "@/lib/auth/messages";

/**
 * /help/sign-in-and-passwords is listed and served only while PASSWORD_SIGNIN_ENABLED is on (a
 * server switch, so the ⌘K list in the browser leaves it out). Each case loads the modules afresh.
 */
async function load(on: boolean, emailProvider = true) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_HELP_PAGES_ENABLED", "true");
  vi.stubEnv("PASSWORD_SIGNIN_ENABLED", on ? "true" : "false");
  vi.stubEnv("MANDRILL_API_KEY", emailProvider ? "test-key-not-real" : "");
  vi.stubEnv("RESEND_API_KEY", "");
  vi.stubEnv("FIREBASE_AUTH_EMULATOR_HOST", "");
  const [pages, agent, api, route] = await Promise.all([
    import("./pages"),
    import("./agentFiles"),
    import("./agentApi"),
    import("@/app/help/sign-in-and-passwords.md/route"),
  ]);
  return { ...pages, ...agent, ...api, GET: route.GET };
}

const ORIGIN = "https://app.example.com";

describe("the sign in and passwords help switch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("off: the page isn't listed, served as Markdown, or given to Vizzy", async () => {
    const { shownHelpPages, helpLlmsTxt, agentHelpPage, GET, nextHelpPage } = await load(false);
    expect(shownHelpPages().map((p) => p.slug)).not.toContain("sign-in-and-passwords");
    expect(helpLlmsTxt(ORIGIN)).not.toContain("sign-in-and-passwords");
    expect(agentHelpPage("sign-in-and-passwords", ORIGIN).status).toBe(404);
    expect(GET().status).toBe(404);
    expect(nextHelpPage("plan-and-usage")?.slug).toBe("email-sending");
  });

  it("on but with no email provider: hidden, like the password form on /login", async () => {
    const { shownHelpPages, helpLlmsTxt, GET } = await load(true, false);
    expect(shownHelpPages().map((p) => p.slug)).not.toContain("sign-in-and-passwords");
    expect(helpLlmsTxt(ORIGIN)).not.toContain("sign-in-and-passwords");
    expect(GET().status).toBe(404);
  });

  it("on: listed in the first group, after Get set up and Plan and usage, and served", async () => {
    const { shownHelpPages, helpLlmsTxt, agentHelpPage, GET, helpPage } = await load(true);
    const slugs = shownHelpPages().map((p) => p.slug);
    expect(slugs.indexOf("sign-in-and-passwords")).toBe(slugs.indexOf("email-sending") - 1);
    expect(helpPage("sign-in-and-passwords")).toMatchObject({ label: "Sign in and passwords", group: "start", path: "/help/sign-in-and-passwords" });
    expect(helpLlmsTxt(ORIGIN)).toContain(`${ORIGIN}/help/sign-in-and-passwords.md`);
    expect(agentHelpPage("sign-in-and-passwords", ORIGIN).status).toBe(200);
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/^# Sign in and passwords\n/);
  });
});

describe("the sign in and passwords page", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("says what the screens say, in house style", async () => {
    const { helpPageMarkdown } = await load(true);
    const md = helpPageMarkdown("sign-in-and-passwords", ORIGIN)!;
    for (const words of [
      AUTH_LABELS.createLink,
      AUTH_LABELS.createAccount,
      AUTH_LABELS.confirmEmail,
      AUTH_LABELS.resendCode,
      AUTH_LABELS.forgotPassword,
      AUTH_LABELS.sendResetLink,
      AUTH_LABELS.savePassword,
      "of at least 12 characters",
      AUTH_MESSAGES.resetLinkOnce,
      `"${AUTH_MESSAGES.signInAgainTitle}"`,
      `"${AUTH_MESSAGES.googleOnly}"`,
      `"${AUTH_MESSAGES.codeHelp}"`,
      // The Settings card's own words.
      SIGN_IN_SECURITY_COPY.title,
      SIGN_IN_SECURITY_COPY.changePassword,
      SIGN_IN_SECURITY_COPY.currentPassword,
      SIGN_IN_SECURITY_COPY.signOutEverywhere,
    ]) {
      expect(md, words).toContain(words);
    }
    for (const section of ["## Who can use a password", "## Create your account", "## The code", "## Forgot your password", "## Change your password", "## Sign out everywhere", "## Running your own copy"]) {
      expect(md).toContain(section);
    }
    expect(md).toContain("[Settings](https://app.example.com/admin/account/settings)");
    expect(md).toContain("[Host your own copy](https://app.example.com/developers/open-source.md)");
    expect(md).toContain("docs/self-host.md");
    expect(dashesIn(md)).toEqual([]);
    expect(aiTellsIn(md)).toEqual([]);
  });
});
