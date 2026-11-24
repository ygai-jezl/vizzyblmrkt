import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { __resetRateLimitState } from "@/lib/tenant/rateLimit";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import type { EmailMessage, EmailResult } from "@/lib/email";
import { failingFirestore } from "@/lib/tenant/testing/failingFirestore";
import {
  confirmEmailCode,
  confirmEmailLink,
  confirmLinkUrl,
  EMAIL_CODE_CLAIM,
  EMAIL_CODE_LIMITS,
  emailCodeMessage,
  emailLinkMessage,
  SEND_FLOOR_MS,
  hashEmailCode,
  hashEmailLink,
  isEmailConfirmed,
  mayGetIn,
  newEmailCode,
  newEmailLinkToken,
  requestEmailCode,
  requestEmailLink,
  verifyPasswordCaller,
  type EmailCodeAuth,
  type EmailCodeDeps,
} from "./emailCode";

const EMAIL_CODES = "email_codes";
const GUARDS = "email_code_guards";
const LINKS = "email_confirm_links";
const PLATFORM = "https://app.example.com";
const UID = "uidAlexExample0001";
const ADDRESS = "Alex@Example.com";
const T0 = new Date("2026-11-24T10:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

interface FakeUser {
  uid: string;
  email?: string;
  emailVerified: boolean;
  customClaims?: Record<string, unknown>;
  providerData: { providerId: string }[];
}

/** Firebase Auth in memory: tokens name a user and how they signed in. */
function fakeAuth() {
  const users = new Map<string, FakeUser>();
  const tokens = new Map<string, { uid: string; provider: string }>();
  const auth = {
    verifyIdToken: vi.fn(async (token: string, _checkRevoked?: boolean) => {
      const t = tokens.get(token);
      if (!t) throw Object.assign(new Error("bad token"), { code: "auth/argument-error" });
      return { uid: t.uid, firebase: { sign_in_provider: t.provider } };
    }),
    getUser: vi.fn(async (uid: string) => {
      const u = users.get(uid);
      if (!u) throw Object.assign(new Error("no user"), { code: "auth/user-not-found" });
      return structuredClone(u);
    }),
    updateUser: vi.fn(async (uid: string, props: Partial<FakeUser>) => {
      const u = users.get(uid)!;
      Object.assign(u, props);
      return structuredClone(u);
    }),
    setCustomUserClaims: vi.fn(async (uid: string, claims: Record<string, unknown> | null) => {
      users.get(uid)!.customClaims = claims ?? undefined;
    }),
  };
  return {
    auth,
    users,
    tokens,
    asAuth: auth as unknown as EmailCodeAuth,
    addPasswordUser(over: Partial<FakeUser> = {}, token = "tok-alex") {
      const u: FakeUser = { uid: UID, email: ADDRESS, emailVerified: false, providerData: [{ providerId: "password" }], ...over };
      users.set(u.uid, u);
      tokens.set(token, { uid: u.uid, provider: "password" });
      return u;
    },
  };
}

let db: FakeFirestore;
let fa: ReturnType<typeof fakeAuth>;
let sent: EmailMessage[];
/** Every wait the send answer made, in milliseconds. */
let sleeps: number[];
let deps: EmailCodeDeps;

beforeEach(() => {
  __resetRateLimitState();
  db = new FakeFirestore();
  fa = fakeAuth();
  sent = [];
  sleeps = [];
  deps = {
    auth: fa.asAuth,
    db,
    now: T0,
    send: async (msg: EmailMessage): Promise<EmailResult> => {
      sent.push(msg);
      return { sent: true, provider: "mandrill", id: "m1" };
    },
    // No real wait: note it, and let work started before it (the email) run to its end.
    sleep: async (ms) => {
      sleeps.push(ms);
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
  vi.stubEnv("ADMIN_ALLOWED_EMAILS", "someone@example.test, alex@example.com");
  vi.stubEnv("ADMIN_ALLOWED_DOMAINS", "example.org");
  vi.stubEnv("SELF_SERVE_SIGNUP_ENABLED", "");
  vi.stubEnv("NEXT_PUBLIC_PLATFORM_ORIGIN", PLATFORM);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** The code in the one email sent. */
const sentCode = () => /^(\d{6}) is your YouGrow code$/.exec(sent[0]!.subject)![1]!;

describe("the code", () => {
  it("is 6 digits, zero padded", () => {
    for (let i = 0; i < 200; i += 1) expect(newEmailCode()).toMatch(/^\d{6}$/);
  });

  it("is stored as the SHA-256 of uid, lower case address and code", () => {
    const expected = createHash("sha256").update(`${UID}:alex@example.com:012345`).digest("hex");
    expect(hashEmailCode(UID, " Alex@Example.COM ", "012345")).toBe(expected);
    expect(hashEmailCode("uidOther", ADDRESS, "012345")).not.toBe(expected);
  });
});

describe("the email", () => {
  const msg = emailCodeMessage("alex@example.com", "042917");

  it("names the code, the 10 minutes and what to do if you didn't ask", () => {
    expect(msg.to).toBe("alex@example.com");
    expect(msg.subject).toBe("042917 is your YouGrow code");
    expect(msg.text).toContain("042917");
    expect(msg.text).toContain("10 minutes");
    expect(msg.text).toContain("Don't share this code with anyone. If you didn't ask for it, someone may have typed your address: ignore this email.");
    expect(msg.html).toContain("042917");
    expect(msg.html).toContain("10 minutes");
    expect(msg.html).toContain("Don't share this code with anyone.");
  });

  it("never says the code is harmless to pass on", () => {
    // Whoever set the password may not be the address holder (an account made for someone else's
    // address), so the email must not promise the code is useless without "your" password.
    for (const body of [msg.text, msg.html]) {
      expect(body).not.toMatch(/without your password/i);
      expect(body).not.toMatch(/nobody can use/i);
    }
  });

  it("turns tracking off and carries the auth-code tag, with no links", () => {
    expect(msg.track).toEqual({ opens: false, clicks: false });
    expect(msg.tags).toEqual(["auth-code"]);
    expect(msg.html).not.toMatch(/<a\s/i);
    expect(msg.text).not.toMatch(/https?:/);
  });

  it("is in house style", () => {
    for (const part of [msg.subject, msg.text!, msg.html]) {
      expect(dashesIn(part)).toEqual([]);
      expect(aiTellsIn(part)).toEqual([]);
    }
  });

  it("only ever carries a 6-digit code", () => {
    expect(() => emailCodeMessage("alex@example.com", "<b>1</b>")).toThrow();
    expect(() => emailCodeMessage("alex@example.com", "12345")).toThrow();
  });
});

describe("who may get a code", () => {
  it("is an exact address on ADMIN_ALLOWED_EMAILS, in any case, never the domain list", () => {
    expect(mayGetIn("ALEX@example.com")).toBe(true);
    expect(mayGetIn(" someone@example.test ")).toBe(true);
    expect(mayGetIn("sam@example.com")).toBe(false);
    expect(mayGetIn("sam@example.org")).toBe(false);
    expect(mayGetIn("")).toBe(false);
  });

  it("is nobody else while self-serve brand creation isn't built, whatever the switch says", () => {
    vi.stubEnv("SELF_SERVE_SIGNUP_ENABLED", "true");
    expect(mayGetIn("sam@example.com")).toBe(false);
  });

  it("knows a confirmed account by its verified address and the marker together", () => {
    expect(isEmailConfirmed({ emailVerified: true, customClaims: { [EMAIL_CODE_CLAIM]: true } })).toBe(true);
    expect(isEmailConfirmed({ emailVerified: true, customClaims: {} })).toBe(false);
    expect(isEmailConfirmed({ emailVerified: false, customClaims: { [EMAIL_CODE_CLAIM]: true } })).toBe(false);
  });
});

describe("verifyPasswordCaller", () => {
  it("checks the token for revocation and returns the account's own address", async () => {
    fa.addPasswordUser();
    const caller = await verifyPasswordCaller("tok-alex", fa.asAuth);
    expect(caller).toMatchObject({ ok: true, uid: UID, email: ADDRESS });
    expect(fa.auth.verifyIdToken).toHaveBeenCalledWith("tok-alex", true);
  });

  it("refuses a bad token, a Google sign-in, a deleted account and an account without a password", async () => {
    expect(await verifyPasswordCaller("nope", fa.asAuth)).toEqual({ ok: false, error: "invalid_id_token" });
    fa.users.set("uidGoogle", { uid: "uidGoogle", email: "g@example.com", emailVerified: true, providerData: [{ providerId: "google.com" }] });
    fa.tokens.set("tok-google", { uid: "uidGoogle", provider: "google.com" });
    expect(await verifyPasswordCaller("tok-google", fa.asAuth)).toEqual({ ok: false, error: "not_a_password_account" });
    fa.tokens.set("tok-gone", { uid: "uidGone", provider: "password" });
    expect(await verifyPasswordCaller("tok-gone", fa.asAuth)).toEqual({ ok: false, error: "invalid_id_token" });
    fa.addPasswordUser({ uid: "uidNoPw", providerData: [{ providerId: "google.com" }] }, "tok-nopw");
    expect(await verifyPasswordCaller("tok-nopw", fa.asAuth)).toEqual({ ok: false, error: "not_a_password_account" });
    fa.addPasswordUser({ uid: "uidNoMail", email: undefined }, "tok-nomail");
    expect(await verifyPasswordCaller("tok-nomail", fa.asAuth)).toEqual({ ok: false, error: "not_a_password_account" });
  });
});

describe("requestEmailCode", () => {
  it("stores a hashed code and emails it to a listed address inside the request, behind the floor", async () => {
    fa.addPasswordUser();
    const res = await requestEmailCode({ idToken: "tok-alex", ip: "203.0.113.7" }, deps);
    expect(res).toEqual({ status: 200, body: { ok: true, resendAfter: 30 } });
    expect(sleeps).toEqual([SEND_FLOOR_MS]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(ADDRESS);
    const code = sentCode();
    const stored = db.raw(EMAIL_CODES, UID)!;
    expect(stored.hash).toBe(hashEmailCode(UID, ADDRESS, code));
    expect(JSON.stringify(stored)).not.toContain(code);
    expect(JSON.stringify(stored).toLowerCase()).not.toContain("alex@example.com");
  });

  it("answers an unlisted address the same, stores a code and emails nothing", async () => {
    fa.addPasswordUser({ email: "sam@example.org" });
    const res = await requestEmailCode({ idToken: "tok-alex", ip: "203.0.113.7" }, deps);
    expect(res).toEqual({ status: 200, body: { ok: true, resendAfter: 30 } });
    // The same wait as an emailed code, so the time taken says nothing.
    expect(sleeps).toEqual([SEND_FLOOR_MS]);
    expect(sent).toHaveLength(0);
    expect(db.raw(EMAIL_CODES, UID)).toBeDefined();
  });

  it("tells a confirmed account so, and sends nothing", async () => {
    fa.addPasswordUser({ emailVerified: true, customClaims: { [EMAIL_CODE_CLAIM]: true } });
    expect(await requestEmailCode({ idToken: "tok-alex", ip: "203.0.113.7" }, deps)).toEqual({ status: 200, body: { ok: true, alreadyVerified: true } });
    expect(sent).toHaveLength(0);
    expect(db.dump(EMAIL_CODES)).toEqual([]);
  });

  it("limits sends per account", async () => {
    fa.addPasswordUser();
    const ask = () => requestEmailCode({ idToken: "tok-alex", ip: "203.0.113.7" }, deps);
    expect((await ask()).status).toBe(200);
    expect((await ask()).status).toBe(200);
    expect(await ask()).toEqual({ status: 429, body: { error: "rate_limited" } });
    expect(sent).toHaveLength(2);
  });

  it("limits sends per address across accounts, by its hash", async () => {
    fa.addPasswordUser({ uid: "uidOne" }, "tok-1");
    fa.addPasswordUser({ uid: "uidTwo", email: "alex@example.com" }, "tok-2");
    fa.addPasswordUser({ uid: "uidThree", email: "ALEX@EXAMPLE.COM" }, "tok-3");
    expect((await requestEmailCode({ idToken: "tok-1", ip: "203.0.113.1" }, deps)).status).toBe(200);
    expect((await requestEmailCode({ idToken: "tok-2", ip: "203.0.113.2" }, deps)).status).toBe(200);
    expect((await requestEmailCode({ idToken: "tok-3", ip: "203.0.113.3" }, deps)).status).toBe(429);
    expect(JSON.stringify(db.dump("rate_limits")).toLowerCase()).not.toContain("alex@example.com");
  });

  it("limits sends per visitor before it looks at the token", async () => {
    expect(EMAIL_CODE_LIMITS.ip).toEqual({ prefix: "auth-code-ip", burstLimit: 5, hourlyLimit: 20 });
    for (let i = 0; i < 5; i += 1) {
      expect((await requestEmailCode({ idToken: `nope-${i}`, ip: "203.0.113.9" }, deps)).status).toBe(401);
    }
    expect((await requestEmailCode({ idToken: "nope-6", ip: "203.0.113.9" }, deps)).status).toBe(429);
    expect(fa.auth.verifyIdToken).toHaveBeenCalledTimes(5);
  });

  it("caps sends per address in the database, even when the shared rate limiter lets everything through", async () => {
    // The shared limiter fails open: its store is down, and its memory is wiped (evicted) each time.
    const limiterDown = failingFirestore(db, { collections: ["rate_limits"] });
    vi.spyOn(console, "error").mockImplementation(() => {});
    fa.addPasswordUser();
    const ask = (minute: number) => {
      __resetRateLimitState();
      return requestEmailCode({ idToken: "tok-alex", ip: `203.0.113.${minute}` }, { ...deps, db: limiterDown, now: at(minute * 60_000) });
    };
    for (let minute = 0; minute < 6; minute += 1) expect((await ask(minute)).status, `send ${minute + 1}`).toBe(200);
    expect(await ask(6)).toEqual({ status: 429, body: { error: "rate_limited" } });
    expect(sent).toHaveLength(6);
    // An hour after the first send, the first slot is free again.
    expect((await ask(60)).status).toBe(200);
    expect(JSON.stringify(db.dump(GUARDS)).toLowerCase()).not.toContain("alex@example.com");
  });

  it("refuses the send, not lets it through, when the database can't count it", async () => {
    fa.addPasswordUser();
    const broken = failingFirestore(db, { collections: [GUARDS] });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await requestEmailCode({ idToken: "tok-alex", ip: "203.0.113.7" }, { ...deps, db: broken })).toEqual({
      status: 429,
      body: { error: "rate_limited" },
    });
    expect(sent).toHaveLength(0);
    expect(db.dump(EMAIL_CODES)).toEqual([]);
  });

  it("logs a failed send without the address or the code, and still answers the same", async () => {
    fa.addPasswordUser();
    deps.send = async () => ({ sent: false, provider: "mandrill", reason: "rejected" });
    const warn = vi.mocked(console.warn);
    expect((await requestEmailCode({ idToken: "tok-alex", ip: "203.0.113.7" }, deps)).status).toBe(200);
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("not sent");
    expect(logged.toLowerCase()).not.toContain("alex@");
  });

  it("refuses a bad token and a Google sign-in", async () => {
    fa.addPasswordUser();
    fa.tokens.set("tok-google", { uid: UID, provider: "google.com" });
    expect(await requestEmailCode({ idToken: "nope", ip: "203.0.113.7" }, deps)).toEqual({ status: 401, body: { error: "invalid_id_token" } });
    expect(await requestEmailCode({ idToken: "tok-google", ip: "203.0.113.7" }, deps)).toEqual({ status: 400, body: { error: "not_a_password_account" } });
  });
});

describe("confirmEmailCode", () => {
  async function sendOne(): Promise<string> {
    await requestEmailCode({ idToken: "tok-alex", ip: "203.0.113.7" }, deps);
    return sentCode();
  }
  const check = (code: string, now = at(60_000)) => confirmEmailCode({ idToken: "tok-alex", code, ip: "203.0.113.7" }, { ...deps, now });
  const wrongFor = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

  it("confirms the account, merges the marker into its claims and deletes the code", async () => {
    fa.addPasswordUser({ customClaims: { kept: "yes" } });
    const code = await sendOne();
    expect(await check(code)).toEqual({ status: 200, body: { ok: true } });
    const user = fa.users.get(UID)!;
    expect(user.emailVerified).toBe(true);
    expect(user.customClaims).toEqual({ kept: "yes", [EMAIL_CODE_CLAIM]: true });
    expect(db.raw(EMAIL_CODES, UID)).toBeUndefined();
    expect(await check(code)).toEqual({ status: 400, body: { error: "code_expired" } });
  });

  it("counts wrong codes down, then refuses after five", async () => {
    fa.addPasswordUser();
    const code = await sendOne();
    const bad = wrongFor(code);
    const left: unknown[] = [];
    for (let i = 0; i < 4; i += 1) left.push((await check(bad)).body);
    expect(left).toEqual([4, 3, 2, 1].map((n) => ({ error: "code_wrong", attemptsLeft: n })));
    expect(await check(bad)).toEqual({ status: 400, body: { error: "code_too_many" } });
    expect(await check(code)).toEqual({ status: 400, body: { error: "code_expired" } });
    expect(fa.users.get(UID)!.emailVerified).toBe(false);
  });

  it("keeps counting wrong tries across new codes, and shuts the address out after 15 in a day", async () => {
    fa.addPasswordUser();
    let minute = 0;
    const wrongRound = async () => {
      __resetRateLimitState();
      const now = at(minute * 60_000);
      minute += 11;
      await requestEmailCode({ idToken: "tok-alex", ip: "203.0.113.7" }, { ...deps, now });
      const bad = wrongFor(sentCode());
      sent.length = 0;
      const answers: unknown[] = [];
      for (let i = 0; i < 5; i += 1) {
        __resetRateLimitState();
        answers.push((await check(bad, new Date(now.getTime() + 1000))).body);
      }
      return answers;
    };
    // Three codes, five wrong tries each: the third code's last try reaches 15 and locks the address.
    await wrongRound();
    await wrongRound();
    const third = await wrongRound();
    expect(third.at(-1)).toEqual({ error: "code_locked" });
    // No new code for the address for the rest of the day, whatever the hourly limits say.
    __resetRateLimitState();
    expect(await requestEmailCode({ idToken: "tok-alex", ip: "203.0.113.8" }, { ...deps, now: at(5 * 60 * 60_000) })).toEqual({
      status: 429,
      body: { error: "code_locked" },
    });
    expect(sent).toHaveLength(0);
    // A day after the first wrong try, the address can ask again.
    __resetRateLimitState();
    expect((await requestEmailCode({ idToken: "tok-alex", ip: "203.0.113.8" }, { ...deps, now: at(25 * 60 * 60_000) })).status).toBe(200);
  });

  it("sets the marker before emailVerified, so a failure between them leaves the account unconfirmed, not removable", async () => {
    fa.addPasswordUser({ customClaims: { kept: "yes" } });
    const code = await sendOne();
    fa.auth.updateUser.mockRejectedValueOnce(new Error("identity toolkit unavailable"));
    await expect(check(code)).rejects.toThrow("identity toolkit unavailable");
    const user = fa.users.get(UID)!;
    expect(user.emailVerified).toBe(false);
    expect(user.customClaims).toEqual({ kept: "yes", [EMAIL_CODE_CLAIM]: true });
    expect(isEmailConfirmed(user)).toBe(false);
    // The same code still confirms it on a retry.
    expect(await check(code)).toEqual({ status: 200, body: { ok: true } });
    expect(fa.users.get(UID)!.emailVerified).toBe(true);
  });

  it("refuses an expired code", async () => {
    fa.addPasswordUser();
    const code = await sendOne();
    expect(await check(code, at(10 * 60_000 + 1))).toEqual({ status: 400, body: { error: "code_expired" } });
    expect(fa.auth.updateUser).not.toHaveBeenCalled();
  });

  it("won't take a code sent to the account's old address", async () => {
    fa.addPasswordUser();
    const code = await sendOne();
    fa.users.get(UID)!.email = "alex.new@example.com";
    expect((await check(code)).body).toEqual({ error: "code_wrong", attemptsLeft: 4 });
  });

  it("refuses input that isn't 6 digits before anything else", async () => {
    expect(await check("12345")).toEqual({ status: 400, body: { error: "invalid_input" } });
    expect(fa.auth.verifyIdToken).not.toHaveBeenCalled();
  });

  it("limits checks per visitor", async () => {
    expect(EMAIL_CODE_LIMITS.checkIp).toEqual({ prefix: "auth-code-check-ip", burstLimit: 10, hourlyLimit: 60 });
    for (let i = 0; i < 10; i += 1) expect((await check("000000")).status).toBe(401);
    expect(await check("000000")).toEqual({ status: 429, body: { error: "rate_limited" } });
  });
});

/** Shuts alex@example.com out of codes: 15 wrong tries over 3 codes, limits reset between tries. */
async function lockOut(): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    __resetRateLimitState();
    const now = at(round * 11 * 60_000);
    await requestEmailCode({ idToken: "tok-alex", ip: "203.0.113.7" }, { ...deps, now });
    const code = sentCode();
    sent.length = 0;
    const bad = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
    for (let i = 0; i < 5; i += 1) {
      __resetRateLimitState();
      await confirmEmailCode({ idToken: "tok-alex", code: bad, ip: "203.0.113.7" }, { ...deps, now: new Date(now.getTime() + 1000) });
    }
  }
  __resetRateLimitState();
}

/** Every line written to the console in this test, joined. */
function consoleText(): string {
  return [console.info, console.warn, console.log, console.error]
    .flatMap((fn) => (vi.isMockFunction(fn) ? fn.mock.calls.flat() : []))
    .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
    .join("\n");
}

/** The token in the one link email sent. */
const sentToken = () => /#t=([A-Za-z0-9_-]+)/.exec(sent[0]!.text!)![1]!;

describe("the lock", () => {
  it("answers code_locked to a check and a send, even for the right code, once locked", async () => {
    fa.addPasswordUser();
    await lockOut();
    const later = at(2 * 60 * 60_000);
    expect(await requestEmailCode({ idToken: "tok-alex", ip: "203.0.113.8" }, { ...deps, now: later })).toEqual({
      status: 429,
      body: { error: "code_locked" },
    });
    expect(sent).toHaveLength(0);
    // Plain rate limits still say rate_limited.
    __resetRateLimitState();
    for (let i = 0; i < 5; i += 1) await requestEmailCode({ idToken: "nope", ip: "203.0.113.9" }, { ...deps, now: later });
    expect(await requestEmailCode({ idToken: "tok-alex", ip: "203.0.113.9" }, { ...deps, now: later })).toEqual({
      status: 429,
      body: { error: "rate_limited" },
    });
    // A code stored before the lock can't be checked either.
    db.seed(EMAIL_CODES, UID, { hash: hashEmailCode(UID, ADDRESS, "123456"), attempts: 0, expiresAt: at(3 * 60 * 60_000).toISOString() });
    expect(await confirmEmailCode({ idToken: "tok-alex", code: "123456", ip: "203.0.113.10" }, { ...deps, now: later })).toEqual({
      status: 400,
      body: { error: "code_locked" },
    });
    expect(fa.users.get(UID)!.emailVerified).toBe(false);
  });

  it("is the same for an address that isn't on the list, so the lock says nothing about the list", async () => {
    fa.addPasswordUser({ email: "sam@example.org" });
    for (let round = 0; round < 3; round += 1) {
      __resetRateLimitState();
      const now = at(round * 11 * 60_000);
      await requestEmailCode({ idToken: "tok-alex", ip: "203.0.113.7" }, { ...deps, now });
      for (let i = 0; i < 5; i += 1) {
        __resetRateLimitState();
        // No code was emailed, but one is stored: every guess is wrong, as for a listed address.
        await confirmEmailCode({ idToken: "tok-alex", code: "000000", ip: "203.0.113.7" }, { ...deps, now: new Date(now.getTime() + 1000) });
      }
    }
    __resetRateLimitState();
    expect(await requestEmailCode({ idToken: "tok-alex", ip: "203.0.113.8" }, { ...deps, now: at(2 * 60 * 60_000) })).toEqual({
      status: 429,
      body: { error: "code_locked" },
    });
  });

  it("logs auth_code_locked once, as a WARNING with the domain only", async () => {
    fa.addPasswordUser();
    await lockOut();
    const later = at(2 * 60 * 60_000);
    await confirmEmailCode({ idToken: "tok-alex", code: "123456", ip: "203.0.113.10" }, { ...deps, now: later });
    const lines = vi
      .mocked(console.warn)
      .mock.calls.map((c) => c[0])
      .filter((v): v is string => typeof v === "string" && v.includes("auth_code_locked"));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      severity: "WARNING",
      message: "[auth] auth_code_locked",
      event: "auth_code_locked",
      emailDomain: "example.com",
    });
    expect(consoleText().toLowerCase()).not.toContain("alex@");
  });
});

describe("the link", () => {
  it("is 32 random bytes in base64url", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const t = newEmailLinkToken();
      expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
      seen.add(t);
    }
    expect(seen.size).toBe(50);
  });

  it("is stored as the SHA-256 of uid, lower case address and token", () => {
    const token = "a".repeat(43);
    const expected = createHash("sha256").update(`link:${UID}:alex@example.com:${token}`).digest("hex");
    expect(hashEmailLink(UID, " Alex@Example.COM ", token)).toBe(expected);
    expect(hashEmailLink("uidOther", ADDRESS, token)).not.toBe(expected);
    expect(hashEmailLink(UID, "sam@example.com", token)).not.toBe(expected);
  });

  it("is built on the platform origin, never a request header, with the token only after the #", () => {
    const token = "b".repeat(43);
    expect(confirmLinkUrl(token)).toBe(`${PLATFORM}/login/confirm#t=${token}`);
    vi.stubEnv("NEXT_PUBLIC_PLATFORM_ORIGIN", "https://app.example.com/some/path/");
    expect(confirmLinkUrl(token)).toBe(`${PLATFORM}/login/confirm#t=${token}`);
    vi.stubEnv("NEXT_PUBLIC_PLATFORM_ORIGIN", "");
    expect(confirmLinkUrl(token)).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_PLATFORM_ORIGIN", "javascript:alert(1)");
    expect(confirmLinkUrl(token)).toBeNull();
    expect(() => confirmLinkUrl("not a token")).toThrow();
  });

  describe("the email", () => {
    const url = `${PLATFORM}/login/confirm#t=${"c".repeat(43)}`;
    const msg = emailLinkMessage("alex@example.com", url);

    it("has the subject, a button and the plain link, and the fixed words", () => {
      expect(msg.to).toBe("alex@example.com");
      expect(msg.subject).toBe("Confirm your YouGrow email");
      expect(msg.text).toContain(url);
      expect(msg.html).toContain(`<a href="${url}"`);
      expect(msg.html.split(url)).toHaveLength(3);
      for (const body of [msg.text!, msg.html]) {
        expect(body.replace(/&#39;/g, "'")).toContain("It works once, for 30 minutes, in a browser where you're signed in to YouGrow with this address.");
        expect(body.replace(/&#39;/g, "'")).toContain("If you didn't ask for this, ignore this email.");
      }
    });

    it("names the button only where there is one: the text part opens on the link itself", () => {
      expect(msg.text!.startsWith(`Open this link to confirm your email address for YouGrow:\n\n${url}\n`)).toBe(true);
      expect(msg.text).not.toMatch(/button/i);
      expect(msg.html).toContain("Press the button to confirm your email address for YouGrow.");
      expect(msg.html).toContain(">Confirm email</a>");
    });

    it("turns tracking off, so the link isn't rewritten through a tracker, and carries the auth-link tag", () => {
      expect(msg.track).toEqual({ opens: false, clicks: false });
      expect(msg.tags).toEqual(["auth-link"]);
    });

    it("is in house style", () => {
      for (const part of [msg.subject, msg.text!, msg.html]) {
        expect(dashesIn(part)).toEqual([]);
        expect(aiTellsIn(part)).toEqual([]);
      }
    });

    it("only ever carries a confirm link", () => {
      expect(() => emailLinkMessage("alex@example.com", "https://elsewhere.example.test/phish")).toThrow();
      expect(() => emailLinkMessage("alex@example.com", `${PLATFORM}/login/confirm?t=${"c".repeat(43)}`)).toThrow();
      expect(() => emailLinkMessage("alex@example.com", `${PLATFORM}/login/confirm#t=<b>x</b>`)).toThrow();
    });
  });

  describe("requestEmailLink", () => {
    const ask = (over: Partial<EmailCodeDeps> = {}, ip = "203.0.113.7") => requestEmailLink({ idToken: "tok-alex", ip }, { ...deps, ...over });

    it("stores a hashed link and emails it to a listed address inside the request, behind the floor", async () => {
      fa.addPasswordUser();
      expect(await ask()).toEqual({ status: 200, body: { ok: true, via: "link" } });
      expect(sleeps).toEqual([SEND_FLOOR_MS]);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.to).toBe(ADDRESS);
      const token = sentToken();
      expect(sent[0]!.text).toContain(`${PLATFORM}/login/confirm#t=${token}`);
      const stored = db.raw(LINKS, UID)!;
      expect(stored.hash).toBe(hashEmailLink(UID, ADDRESS, token));
      expect(stored.expiresAt).toBe("2026-11-24T10:30:00.000Z");
      expect(JSON.stringify(stored)).not.toContain(token);
      expect(JSON.stringify(stored).toLowerCase()).not.toContain("alex@example.com");
      // A link doesn't touch the code.
      expect(db.raw(EMAIL_CODES, UID)).toBeUndefined();
    });

    it("answers an unlisted address the same, behind the same floor, and emails nothing", async () => {
      fa.addPasswordUser({ email: "sam@example.org" });
      expect(await ask()).toEqual({ status: 200, body: { ok: true, via: "link" } });
      expect(sleeps).toEqual([SEND_FLOOR_MS]);
      expect(sent).toHaveLength(0);
      expect(db.raw(LINKS, UID)).toBeDefined();
    });

    it("answers 503 link_unavailable with no platform origin, and stores, counts and sends nothing", async () => {
      fa.addPasswordUser();
      vi.stubEnv("NEXT_PUBLIC_PLATFORM_ORIGIN", "");
      expect(await ask()).toEqual({ status: 503, body: { error: "link_unavailable" } });
      expect(sent).toHaveLength(0);
      expect(sleeps).toEqual([]);
      expect(db.dump(LINKS)).toEqual([]);
      expect(db.dump(GUARDS)).toEqual([]);
    });

    it("is sent while the address is locked out of codes", async () => {
      fa.addPasswordUser();
      await lockOut();
      expect((await requestEmailCode({ idToken: "tok-alex", ip: "203.0.113.8" }, { ...deps, now: at(2 * 60 * 60_000) })).body).toEqual({
        error: "code_locked",
      });
      __resetRateLimitState();
      expect(await ask({ now: at(2 * 60 * 60_000) })).toEqual({ status: 200, body: { ok: true, via: "link" } });
      expect(sent).toHaveLength(1);
    });

    it("counts toward the address's 6 sends an hour, with codes, even when the shared limiter lets everything through", async () => {
      const limiterDown = failingFirestore(db, { collections: ["rate_limits"] });
      vi.spyOn(console, "error").mockImplementation(() => {});
      fa.addPasswordUser();
      const go = (minute: number, via: "code" | "link") => {
        __resetRateLimitState();
        const d = { ...deps, db: limiterDown, now: at(minute * 60_000) };
        const input = { idToken: "tok-alex", ip: `203.0.113.${minute}` };
        return via === "link" ? requestEmailLink(input, d) : requestEmailCode(input, d);
      };
      for (let minute = 0; minute < 3; minute += 1) expect((await go(minute, "code")).status).toBe(200);
      for (let minute = 3; minute < 6; minute += 1) expect((await go(minute, "link")).status).toBe(200);
      expect(await go(6, "link")).toEqual({ status: 429, body: { error: "rate_limited" } });
      expect(await go(6, "code")).toEqual({ status: 429, body: { error: "rate_limited" } });
      expect(sent).toHaveLength(6);
    });

    it("shares the per account limit with codes", async () => {
      fa.addPasswordUser();
      expect((await requestEmailCode({ idToken: "tok-alex", ip: "203.0.113.7" }, deps)).status).toBe(200);
      expect((await ask()).status).toBe(200);
      expect(await ask()).toEqual({ status: 429, body: { error: "rate_limited" } });
    });

    it("tells a confirmed account so, and refuses a bad token and a Google sign-in", async () => {
      fa.addPasswordUser({ emailVerified: true, customClaims: { [EMAIL_CODE_CLAIM]: true } });
      expect(await ask()).toEqual({ status: 200, body: { ok: true, alreadyVerified: true } });
      fa.tokens.set("tok-google", { uid: UID, provider: "google.com" });
      expect(await requestEmailLink({ idToken: "nope", ip: "203.0.113.7" }, deps)).toEqual({ status: 401, body: { error: "invalid_id_token" } });
      expect(await requestEmailLink({ idToken: "tok-google", ip: "203.0.113.7" }, deps)).toEqual({ status: 400, body: { error: "not_a_password_account" } });
      expect(sent).toHaveLength(0);
    });
  });

  describe("confirmEmailLink", () => {
    async function sendLink(over: Partial<EmailCodeDeps> = {}): Promise<string> {
      await requestEmailLink({ idToken: "tok-alex", ip: "203.0.113.7" }, { ...deps, ...over });
      const token = sentToken();
      sent.length = 0;
      return token;
    }
    const open = (link: string, now = at(60_000), idToken = "tok-alex") => confirmEmailLink({ idToken, link, ip: "203.0.113.7" }, { ...deps, now });

    it("confirms the account like a right code, then deletes the link and any code", async () => {
      fa.addPasswordUser({ customClaims: { kept: "yes" } });
      await requestEmailCode({ idToken: "tok-alex", ip: "203.0.113.7" }, deps);
      sent.length = 0;
      const link = await sendLink();
      expect(db.raw(EMAIL_CODES, UID)).toBeDefined();
      expect(await open(link)).toEqual({ status: 200, body: { ok: true } });
      const user = fa.users.get(UID)!;
      expect(user.emailVerified).toBe(true);
      expect(user.customClaims).toEqual({ kept: "yes", [EMAIL_CODE_CLAIM]: true });
      // The marker before emailVerified, as for a code.
      expect(fa.auth.setCustomUserClaims.mock.invocationCallOrder[0]!).toBeLessThan(fa.auth.updateUser.mock.invocationCallOrder[0]!);
      expect(db.raw(LINKS, UID)).toBeUndefined();
      expect(db.raw(EMAIL_CODES, UID)).toBeUndefined();
    });

    it("is cancelled by a right code: nothing stays live once the account is confirmed", async () => {
      fa.addPasswordUser();
      await requestEmailCode({ idToken: "tok-alex", ip: "203.0.113.7" }, deps);
      const code = sentCode();
      sent.length = 0;
      const link = await sendLink();
      expect(db.raw(LINKS, UID)).toBeDefined();
      expect(await confirmEmailCode({ idToken: "tok-alex", code, ip: "203.0.113.7" }, { ...deps, now: at(60_000) })).toEqual({ status: 200, body: { ok: true } });
      expect(db.raw(LINKS, UID)).toBeUndefined();
      expect(db.raw(EMAIL_CODES, UID)).toBeUndefined();
      expect(await open(link, at(61_000))).toEqual({ status: 400, body: { error: "link_invalid" } });
    });

    it("works once", async () => {
      fa.addPasswordUser();
      const link = await sendLink();
      expect((await open(link)).status).toBe(200);
      expect(await open(link, at(61_000))).toEqual({ status: 400, body: { error: "link_invalid" } });
    });

    it("works only for the account it was sent for: another account's token gets link_invalid", async () => {
      fa.addPasswordUser();
      // Someone else's account, signed in on their own browser, holding the same link.
      fa.addPasswordUser({ uid: "uidSamExample0002", email: "sam@example.com" }, "tok-sam");
      const link = await sendLink();
      expect(await open(link, at(60_000), "tok-sam")).toEqual({ status: 400, body: { error: "link_invalid" } });
      expect(fa.users.get("uidSamExample0002")!.emailVerified).toBe(false);
      // An account made again for the same address has another uid: the link isn't for it either.
      fa.addPasswordUser({ uid: "uidAlexAgain0003" }, "tok-again");
      expect(await open(link, at(60_000), "tok-again")).toEqual({ status: 400, body: { error: "link_invalid" } });
      expect(fa.auth.updateUser).not.toHaveBeenCalled();
      // The right account still can.
      expect((await open(link)).status).toBe(200);
    });

    it("won't take a link sent to the account's old address", async () => {
      fa.addPasswordUser();
      const link = await sendLink();
      fa.users.get(UID)!.email = "alex.new@example.com";
      expect(await open(link)).toEqual({ status: 400, body: { error: "link_invalid" } });
    });

    it("expires after 30 minutes", async () => {
      fa.addPasswordUser();
      const link = await sendLink();
      expect(await open(link, at(30 * 60_000 + 1))).toEqual({ status: 400, body: { error: "link_invalid" } });
      expect(db.raw(LINKS, UID)).toBeUndefined();
      expect(fa.auth.updateUser).not.toHaveBeenCalled();
    });

    it("is replaced by a newer link", async () => {
      fa.addPasswordUser();
      const first = await sendLink();
      __resetRateLimitState();
      const second = await sendLink({ now: at(2 * 60_000) });
      expect(await open(first, at(3 * 60_000))).toEqual({ status: 400, body: { error: "link_invalid" } });
      expect((await open(second, at(3 * 60_000))).status).toBe(200);
    });

    it("works while the address is locked out of codes", async () => {
      fa.addPasswordUser();
      await lockOut();
      const link = await sendLink({ now: at(2 * 60 * 60_000) });
      expect(await open(link, at(2 * 60 * 60_000 + 1000))).toEqual({ status: 200, body: { ok: true } });
      expect(isEmailConfirmed(fa.users.get(UID)!)).toBe(true);
    });

    it("refuses a token that isn't base64url of the right length before anything else", async () => {
      for (const link of ["short", "a".repeat(101), "a".repeat(30) + "+/=", ""]) {
        expect(await open(link)).toEqual({ status: 400, body: { error: "invalid_input" } });
      }
      expect(fa.auth.verifyIdToken).not.toHaveBeenCalled();
    });

    it("refuses a bad token and a Google sign-in", async () => {
      fa.addPasswordUser();
      fa.tokens.set("tok-google", { uid: UID, provider: "google.com" });
      expect(await open("d".repeat(43), at(1000), "nope")).toEqual({ status: 401, body: { error: "invalid_id_token" } });
      expect(await open("d".repeat(43), at(1000), "tok-google")).toEqual({ status: 400, body: { error: "not_a_password_account" } });
    });

    it("limits checks per visitor", async () => {
      expect(EMAIL_CODE_LIMITS.linkCheckIp).toEqual({ prefix: "auth-link-check-ip", burstLimit: 10, hourlyLimit: 60 });
      for (let i = 0; i < 10; i += 1) expect((await open("e".repeat(43), at(1000), "nope")).status).toBe(401);
      expect(await open("e".repeat(43), at(1000), "nope")).toEqual({ status: 429, body: { error: "rate_limited" } });
    });

    it("never logs the address or the token", async () => {
      fa.addPasswordUser();
      deps.send = async (msg) => {
        sent.push(msg);
        return { sent: false, provider: "mandrill", reason: "rejected" };
      };
      const link = await sendLink();
      await open("f".repeat(43));
      await open(link, at(31 * 60_000));
      const logged = consoleText();
      expect(logged).toContain("not sent");
      expect(logged.toLowerCase()).not.toContain("alex@");
      expect(logged).not.toContain(link);
    });
  });
});
