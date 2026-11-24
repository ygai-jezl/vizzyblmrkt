import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { __resetRateLimitState } from "@/lib/tenant/rateLimit";

// POST sends a code, PUT checks it. Firebase Auth, the database and the email provider are
// fakes; the send answer's fixed wait is noted instead of waited out.
interface FakeUser {
  uid: string;
  email?: string;
  emailVerified: boolean;
  customClaims?: Record<string, unknown>;
  providerData: { providerId: string }[];
}
const fake = vi.hoisted(() => ({
  users: new Map<string, FakeUser>(),
  tokens: new Map<string, { uid: string; provider: string }>(),
  db: null as unknown,
  waits: [] as number[],
}));
const auth = vi.hoisted(() => ({
  verifyIdToken: vi.fn(async (token: string, _checkRevoked?: boolean) => {
    const t = fake.tokens.get(token);
    if (!t) throw Object.assign(new Error("bad token"), { code: "auth/argument-error" });
    return { uid: t.uid, firebase: { sign_in_provider: t.provider } };
  }),
  getUser: vi.fn(async (uid: string) => {
    const u = fake.users.get(uid);
    if (!u) throw Object.assign(new Error("no user"), { code: "auth/user-not-found" });
    return structuredClone(u);
  }),
  updateUser: vi.fn(async (uid: string, props: Record<string, unknown>) => {
    const u = fake.users.get(uid)!;
    Object.assign(u, props);
    return structuredClone(u);
  }),
  setCustomUserClaims: vi.fn(async (uid: string, claims: Record<string, unknown> | null) => {
    fake.users.get(uid)!.customClaims = claims ?? undefined;
  }),
}));
vi.mock("@/lib/auth/adminAuth", () => ({ adminAuth: () => auth }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => fake.db,
}));
const email = vi.hoisted(() => ({ sendEmail: vi.fn(async (_msg: { to: string; subject: string }) => ({ sent: true, provider: "mandrill" as const, id: "m1" })) }));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendEmail: email.sendEmail,
}));
vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers/promises")>()),
  // Note the wait, and let work started before it (the email) run to its end.
  setTimeout: async (ms: number) => {
    fake.waits.push(ms);
    await new Promise((resolve) => setImmediate(resolve));
  },
}));

const { POST, PUT } = await import("./route");
const { SEND_FLOOR_MS } = await import("@/lib/auth/emailCode");

const ORIGIN = "http://localhost:3002";
const UID = "uidAlexExample0001";
const T0 = new Date("2026-11-24T10:00:00.000Z");
let db: FakeFirestore;

function addPasswordUser(over: Partial<FakeUser> = {}, token = "tok-alex"): FakeUser {
  const u: FakeUser = { uid: UID, email: "alex@example.com", emailVerified: false, providerData: [{ providerId: "password" }], ...over };
  fake.users.set(u.uid, u);
  fake.tokens.set(token, { uid: u.uid, provider: "password" });
  return u;
}

function req(method: "POST" | "PUT", body: unknown, headers: Record<string, string> = {}, ip = "203.0.113.7") {
  return new Request(`${ORIGIN}/api/auth/email-code`, {
    method,
    headers: { "content-type": "application/json", host: "localhost:3002", origin: ORIGIN, "x-forwarded-for": ip, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const send = (idToken = "tok-alex", ip?: string) => POST(req("POST", { idToken }, {}, ip));
const check = (code: string, idToken = "tok-alex") => PUT(req("PUT", { idToken, code }));
async function sendAndRead(): Promise<string> {
  expect((await send()).status).toBe(200);
  const subject = email.sendEmail.mock.calls.at(-1)![0].subject;
  return /^(\d{6}) is your YouGrow code$/.exec(subject)![1]!;
}
const wrongFor = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimitState();
  fake.users.clear();
  fake.tokens.clear();
  fake.waits.length = 0;
  db = new FakeFirestore();
  fake.db = db;
  vi.useFakeTimers({ now: T0, toFake: ["Date"] });
  vi.stubEnv("PASSWORD_SIGNIN_ENABLED", "true");
  vi.stubEnv("FIREBASE_AUTH_EMULATOR_HOST", "127.0.0.1:9099");
  vi.stubEnv("ADMIN_ALLOWED_EMAILS", "alex@example.com");
  vi.stubEnv("ADMIN_ALLOWED_DOMAINS", "example.org");
  vi.stubEnv("SELF_SERVE_SIGNUP_ENABLED", "");
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("both methods", () => {
  it("503 while password sign-in is off, or on with no way to deliver a code", async () => {
    addPasswordUser();
    vi.stubEnv("PASSWORD_SIGNIN_ENABLED", "");
    for (const res of [await send(), await check("123456")]) {
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "password_signin_disabled" });
    }
    vi.stubEnv("PASSWORD_SIGNIN_ENABLED", "true");
    vi.stubEnv("FIREBASE_AUTH_EMULATOR_HOST", "");
    vi.stubEnv("MANDRILL_API_KEY", "");
    vi.stubEnv("RESEND_API_KEY", "");
    expect((await send()).status).toBe(503);
    expect(auth.verifyIdToken).not.toHaveBeenCalled();
  });

  it("403 for a cross-site request or another origin", async () => {
    addPasswordUser();
    const crossSite = await POST(req("POST", { idToken: "tok-alex" }, { "sec-fetch-site": "cross-site" }));
    expect(crossSite.status).toBe(403);
    expect(await crossSite.json()).toEqual({ error: "cross_site_forbidden" });
    const otherOrigin = await PUT(req("PUT", { idToken: "tok-alex", code: "123456" }, { origin: "https://elsewhere.example.test" }));
    expect(otherOrigin.status).toBe(403);
    expect(auth.verifyIdToken).not.toHaveBeenCalled();
  });

  it("400 invalid_input for a body that isn't right", async () => {
    for (const res of [
      await POST(req("POST", "not json")),
      await POST(req("POST", {})),
      await POST(req("POST", { idToken: "" })),
      await PUT(req("PUT", { idToken: "tok-alex" })),
      await PUT(req("PUT", { idToken: "tok-alex", code: "12345" })),
      await PUT(req("PUT", { idToken: "tok-alex", code: "12a456" })),
      await PUT(req("PUT", { idToken: "tok-alex", code: "1234567" })),
    ]) {
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_input" });
    }
    expect(auth.verifyIdToken).not.toHaveBeenCalled();
  });

  it("401 for a token that doesn't verify, checked for revocation", async () => {
    for (const res of [await send("nope"), await check("123456", "nope")]) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "invalid_id_token" });
    }
    expect(auth.verifyIdToken).toHaveBeenCalledWith("nope", true);
  });

  it("400 not_a_password_account for a Google sign-in", async () => {
    fake.users.set("uidGoogle", { uid: "uidGoogle", email: "alex@example.com", emailVerified: true, providerData: [{ providerId: "google.com" }] });
    fake.tokens.set("tok-google", { uid: "uidGoogle", provider: "google.com" });
    for (const res of [await send("tok-google"), await check("123456", "tok-google")]) {
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "not_a_password_account" });
    }
    expect(email.sendEmail).not.toHaveBeenCalled();
  });
});

describe("POST: send a code", () => {
  it("emails one code to a listed address inside the request, behind the fixed wait", async () => {
    addPasswordUser();
    const res = await send();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, resendAfter: 30 });
    expect(fake.waits).toEqual([SEND_FLOOR_MS]);
    expect(email.sendEmail).toHaveBeenCalledTimes(1);
    const msg = email.sendEmail.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(msg).toMatchObject({ to: "alex@example.com", track: { opens: false, clicks: false }, tags: ["auth-code"] });
    expect(String(msg.subject)).toMatch(/^\d{6} is your YouGrow code$/);
    expect(db.dump("email_codes")).toHaveLength(1);
  });

  it("answers an unlisted address the same 200 and sends nothing", async () => {
    addPasswordUser({ email: "sam@example.org" });
    const res = await send();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, resendAfter: 30 });
    expect(fake.waits).toEqual([SEND_FLOOR_MS]);
    expect(email.sendEmail).not.toHaveBeenCalled();
    // A code is stored all the same, so a check answers as it would for a listed address.
    const typed = await check("000000");
    expect(typed.status).toBe(400);
    expect(await typed.json()).toEqual({ error: "code_wrong", attemptsLeft: 4 });
  });

  it("tells an account that already confirmed, and sends nothing", async () => {
    addPasswordUser({ emailVerified: true, customClaims: { email_code: true } });
    const res = await send();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, alreadyVerified: true });
    expect(email.sendEmail).not.toHaveBeenCalled();
  });

  it("429 rate_limited after two sends a minute for one account, and a new send replaces the code", async () => {
    addPasswordUser();
    const first = await sendAndRead();
    const second = await sendAndRead();
    const limited = await send();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect(email.sendEmail).toHaveBeenCalledTimes(2);
    if (first !== second) {
      expect(await (await check(first)).json()).toEqual({ error: "code_wrong", attemptsLeft: 4 });
    }
    expect((await check(second)).status).toBe(200);
  });

  it("429 rate_limited after five sends a minute from one visitor", async () => {
    for (let i = 0; i < 5; i += 1) addPasswordUser({ uid: `uidVisitor${i}`, email: `person${i}@example.com` }, `tok-${i}`);
    for (let i = 0; i < 5; i += 1) expect((await send(`tok-${i}`, "198.51.100.4")).status).toBe(200);
    expect((await send("tok-0", "198.51.100.4")).status).toBe(429);
  });
});

describe("PUT: check the code", () => {
  it("confirms the account: emailVerified, the marker merged into its claims, and the code deleted", async () => {
    addPasswordUser({ customClaims: { theme: "dark" } });
    const code = await sendAndRead();
    const res = await check(code);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(auth.updateUser).toHaveBeenCalledWith(UID, { emailVerified: true });
    const user = fake.users.get(UID)!;
    expect(user.emailVerified).toBe(true);
    expect(user.customClaims).toEqual({ theme: "dark", email_code: true });
    expect(db.raw("email_codes", UID)).toBeUndefined();
    // Used once: the same code again finds nothing.
    expect(await (await check(code)).json()).toEqual({ error: "code_expired" });
  });

  it("counts a wrong code down", async () => {
    addPasswordUser();
    const bad = wrongFor(await sendAndRead());
    const first = await check(bad);
    expect(first.status).toBe(400);
    expect(await first.json()).toEqual({ error: "code_wrong", attemptsLeft: 4 });
    expect(await (await check(bad)).json()).toEqual({ error: "code_wrong", attemptsLeft: 3 });
    expect(fake.users.get(UID)!.emailVerified).toBe(false);
  });

  it("refuses a code after its 10 minutes", async () => {
    addPasswordUser();
    const code = await sendAndRead();
    vi.setSystemTime(new Date(T0.getTime() + 10 * 60_000 + 1));
    const res = await check(code);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "code_expired" });
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it("deletes the code on the fifth wrong try, so even the right one stops working", async () => {
    addPasswordUser();
    const code = await sendAndRead();
    const bad = wrongFor(code);
    for (let i = 0; i < 4; i += 1) expect((await check(bad)).status).toBe(400);
    const fifth = await check(bad);
    expect(fifth.status).toBe(400);
    expect(await fifth.json()).toEqual({ error: "code_too_many" });
    expect(db.raw("email_codes", UID)).toBeUndefined();
    expect(await (await check(code)).json()).toEqual({ error: "code_expired" });
    expect(fake.users.get(UID)!.emailVerified).toBe(false);
  });

  it("429 rate_limited after ten checks a minute from one visitor", async () => {
    addPasswordUser();
    for (let i = 0; i < 10; i += 1) await check("000000", "nope");
    const res = await check("000000");
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
  });

  it("500 server_error when Firebase Auth fails while confirming, and the code still works after", async () => {
    addPasswordUser();
    const code = await sendAndRead();
    vi.spyOn(console, "error").mockImplementation(() => {});
    auth.updateUser.mockRejectedValueOnce(new Error("unavailable"));
    const res = await check(code);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "server_error" });
    expect((await check(code)).status).toBe(200);
  });
});
