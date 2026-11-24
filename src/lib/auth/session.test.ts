import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DecodedIdToken, UserRecord } from "firebase-admin/auth";

// ── Stub firebase-admin so ensureAdminAccess runs without real credentials. ──
// Wrapper-arrow style (see crm/enrichWorker.test.ts) so the spies stay
// controllable per-test despite vi.mock hoisting.
const verifyIdToken = vi.fn();
const getUser = vi.fn();
const setCustomUserClaims = vi.fn();
const createSessionCookie = vi.fn();
const deleteUser = vi.fn();
const revokeRefreshTokens = vi.fn();

vi.mock("firebase-admin/app", () => ({
  // Non-empty → adminAuth() returns the existing app and skips initializeApp.
  getApps: () => [{}],
  initializeApp: () => ({}),
  applicationDefault: () => ({}),
}));
vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({
    verifyIdToken: (...a: unknown[]) => verifyIdToken(...a),
    getUser: (...a: unknown[]) => getUser(...a),
    setCustomUserClaims: (...a: unknown[]) => setCustomUserClaims(...a),
    createSessionCookie: (...a: unknown[]) => createSessionCookie(...a),
    deleteUser: (...a: unknown[]) => deleteUser(...a),
    revokeRefreshTokens: (...a: unknown[]) => revokeRefreshTokens(...a),
  }),
}));
// session.ts imports these at module top; they're never called by ensureAdminAccess.
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
// The self-serve seam is unreachable with the real switch; tests open it here.
const flags = vi.hoisted(() => ({ isSelfServeSignupOpen: vi.fn(() => false) }));
vi.mock("./flags", () => flags);

import { ensureAdminAccess, revokeAllSessions } from "./session";

const CREATED = Date.parse("2026-11-24T10:00:00Z");
const NOW = CREATED + 60_000;
const utc = (ms: number) => new Date(ms).toUTCString();
const EMAIL = "founder@example.com";
const CLAIMS = { tenant_id: "ten_demo", region: "us", role: "admin" };

/** A verified Google sign-in token; Google created the account in this sign-in. */
function tok(overrides: Record<string, unknown> = {}): DecodedIdToken {
  return {
    uid: "u1",
    email: EMAIL,
    email_verified: true,
    auth_time: CREATED / 1000,
    firebase: { sign_in_provider: "google.com", identities: {} },
    ...overrides,
  } as unknown as DecodedIdToken;
}
const pwTok = (overrides: Record<string, unknown> = {}) =>
  tok({ firebase: { sign_in_provider: "password", identities: {} }, auth_time: (CREATED + 30 * 60_000) / 1000, ...overrides });

/** The account as Auth holds it: a fresh, verified Google account by default. */
function user(overrides: Record<string, unknown> = {}): UserRecord {
  return {
    uid: "u1",
    email: EMAIL,
    emailVerified: true,
    providerData: [{ providerId: "google.com", email: EMAIL }],
    metadata: { creationTime: utc(CREATED) },
    tokensValidAfterTime: utc(CREATED),
    customClaims: undefined,
    ...overrides,
  } as unknown as UserRecord;
}
const passwordData = [{ providerId: "password", email: EMAIL }];

function signIn(t: DecodedIdToken, u: UserRecord) {
  verifyIdToken.mockResolvedValue(t);
  getUser.mockResolvedValue(u);
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("FIREBASE_AUTH_EMULATOR_HOST", "");
  vi.stubEnv("FIRESTORE_EMULATOR_HOST", "");
  // Nothing is allowed by default; these tests run as a deployment that names its own.
  vi.stubEnv("ADMIN_ALLOWED_DOMAINS", "example.com");
  vi.stubEnv("ADMIN_ALLOWED_EMAILS", "");
  vi.stubEnv("ADMIN_BOOTSTRAP_TENANT_ID", "ten_demo");
  vi.stubEnv("ADMIN_BOOTSTRAP_REGION", "eu");
  flags.isSelfServeSignupOpen.mockReturnValue(false);
});
afterEach(() => {
  vi.unstubAllEnvs();
  warn.mockRestore();
});

/** The structured log lines written, parsed. */
const logged = () => warn.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);

describe("ensureAdminAccess: verifying the token", () => {
  it("verifies with the revocation check and reads the account", async () => {
    signIn(tok(CLAIMS), user({ customClaims: CLAIMS }));
    await ensureAdminAccess("t", NOW);
    expect(verifyIdToken).toHaveBeenCalledWith("t", true);
    expect(getUser).toHaveBeenCalledWith("u1");
  });

  it("throws (the route answers 401) when the token is bad or revoked", async () => {
    verifyIdToken.mockRejectedValue(Object.assign(new Error("revoked"), { code: "auth/id-token-revoked" }));
    await expect(ensureAdminAccess("t", NOW)).rejects.toThrow("revoked");
    expect(getUser).not.toHaveBeenCalled();
  });
});

describe("ensureAdminAccess: authentication (rules 2 and 4)", () => {
  it("refuses an unverified Google email even if the domain is allowlisted (core vuln closed)", async () => {
    signIn(tok({ email_verified: false }), user({ emailVerified: false }));
    await expect(ensureAdminAccess("t", NOW)).resolves.toBe("forbidden");
    expect(setCustomUserClaims).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("answers email_not_verified for a password account that hasn't confirmed its code", async () => {
    vi.stubEnv("ADMIN_ALLOWED_EMAILS", EMAIL);
    signIn(pwTok({ email_verified: false }), user({ emailVerified: false, providerData: passwordData }));
    await expect(ensureAdminAccess("t", NOW)).resolves.toBe("email_not_verified");
    expect(setCustomUserClaims).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("refuses a sign-in that is neither Google nor password", async () => {
    signIn(tok({ firebase: { sign_in_provider: "anonymous", identities: {} } }), user());
    await expect(ensureAdminAccess("t", NOW)).resolves.toBe("forbidden");
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("removes an unexplained first sign-in, logs the domain only, and asks for a new sign-in", async () => {
    // A Google sign-in on an account made an hour before (a squat Google took over).
    signIn(tok({ auth_time: (CREATED + 3_600_000) / 1000 }), user({ providerData: [...passwordData, { providerId: "google.com", email: EMAIL }] }));
    await expect(ensureAdminAccess("t", CREATED + 3_600_000)).resolves.toBe("sign_in_again");
    expect(deleteUser).toHaveBeenCalledWith("u1");
    expect(setCustomUserClaims).not.toHaveBeenCalled();
    const [line] = logged();
    expect(line).toMatchObject({
      severity: "WARNING",
      event: "auth_account_removed",
      reason: "unexplained",
      provider: "google.com",
      emailDomain: "example.com",
      accountAgeSeconds: 3600,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("founder@");
  });

  it("refuses, without removing or logging a removal, a later sign-in by someone on no list", async () => {
    // A stranger's Google account from an earlier, refused sign-in: rule 4 fails, but there is
    // nothing of ours to protect, so it is refused as before and the removal alert stays quiet.
    vi.stubEnv("ADMIN_ALLOWED_DOMAINS", "");
    signIn(tok({ auth_time: (CREATED + 3_600_000) / 1000 }), user());
    await expect(ensureAdminAccess("t", CREATED + 3_600_000)).resolves.toBe("forbidden");
    expect(deleteUser).not.toHaveBeenCalled();
    expect(logged().some((l) => l.event === "auth_account_removed")).toBe(false);
  });

  it("answers google_only, without removing, for a domain-only address whose password account fails rule 4", async () => {
    signIn(pwTok(), user({ providerData: passwordData, tokensValidAfterTime: utc(CREATED + 600_000), customClaims: { email_code: true } }));
    await expect(ensureAdminAccess("t", NOW)).resolves.toBe("google_only");
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("removes a password account touched since it was created", async () => {
    vi.stubEnv("ADMIN_ALLOWED_EMAILS", EMAIL);
    signIn(pwTok(), user({ providerData: passwordData, tokensValidAfterTime: utc(CREATED + 600_000), customClaims: { email_code: true } }));
    await expect(ensureAdminAccess("t", NOW)).resolves.toBe("sign_in_again");
    expect(deleteUser).toHaveBeenCalledWith("u1");
    expect(logged()[0]).toMatchObject({ event: "auth_account_removed", reason: "touched", provider: "password" });
  });

  it("removes a trojan on a first sign-in, before anything else", async () => {
    signIn(tok(), user({ providerData: [...passwordData, { providerId: "google.com", email: "someone@example.test" }] }));
    await expect(ensureAdminAccess("t", NOW)).resolves.toBe("sign_in_again");
    expect(deleteUser).toHaveBeenCalledWith("u1");
    expect(logged()[0]).toMatchObject({ event: "auth_account_removed", reason: "trojan" });
  });

  it("refuses a trojan on an established account and never deletes it", async () => {
    signIn(tok(CLAIMS), user({ customClaims: CLAIMS, providerData: [{ providerId: "google.com", email: EMAIL }, { providerId: "password", email: "someone@example.test" }] }));
    await expect(ensureAdminAccess("t", NOW)).resolves.toBe("forbidden");
    expect(deleteUser).not.toHaveBeenCalled();
    expect(logged()[0]).toMatchObject({ event: "auth_sign_in_refused", reason: "trojan", emailDomain: "example.com" });
  });

  it("refuses an established account whose Google address was renamed, logged under its own reason", async () => {
    signIn(tok(CLAIMS), user({ customClaims: CLAIMS, providerData: [{ providerId: "google.com", email: "alex.smith@example.com" }] }));
    await expect(ensureAdminAccess("t", NOW)).resolves.toBe("forbidden");
    expect(deleteUser).not.toHaveBeenCalled();
    expect(logged()[0]).toMatchObject({ event: "auth_sign_in_refused", reason: "provider_email_changed", provider: "google.com", emailDomain: "example.com" });
  });

  it("logs and throws when the account can't be deleted, so nothing is granted", async () => {
    signIn(tok({ auth_time: (CREATED + 3_600_000) / 1000 }), user());
    deleteUser.mockRejectedValue(Object.assign(new Error("permission denied"), { code: "auth/insufficient-permission" }));
    await expect(ensureAdminAccess("t", NOW)).rejects.toThrow("permission denied");
    expect(setCustomUserClaims).not.toHaveBeenCalled();
    expect(logged()[0]).toMatchObject({ event: "auth_account_remove_failed", reason: "unexplained", errorCode: "auth/insufficient-permission" });
  });

  it("treats an account another door call already deleted as removed", async () => {
    signIn(tok({ auth_time: (CREATED + 3_600_000) / 1000 }), user());
    deleteUser.mockRejectedValue(Object.assign(new Error("no user"), { code: "auth/user-not-found" }));
    await expect(ensureAdminAccess("t", NOW)).resolves.toBe("sign_in_again");
    expect(logged()[0]).toMatchObject({ event: "auth_account_removed", reason: "unexplained" });
  });

  it("runs the same checks on the local emulator (no bypass)", async () => {
    vi.stubEnv("FIREBASE_AUTH_EMULATOR_HOST", "127.0.0.1:9099");
    vi.stubEnv("FIRESTORE_EMULATOR_HOST", "127.0.0.1:8080");
    signIn(pwTok({ email_verified: false }), user({ emailVerified: false, providerData: passwordData }));
    await expect(ensureAdminAccess("t", NOW)).resolves.toBe("email_not_verified");
    expect(setCustomUserClaims).not.toHaveBeenCalled();
  });

  it("lets the seeded local admin in with a password (the smoke test's sign-in)", async () => {
    vi.stubEnv("FIREBASE_AUTH_EMULATOR_HOST", "127.0.0.1:9099");
    vi.stubEnv("ADMIN_ALLOWED_DOMAINS", "");
    vi.stubEnv("ADMIN_ALLOWED_EMAILS", "admin@example.com");
    const seeded = {
      email: "admin@example.com",
      providerData: [
        { providerId: "password", email: "admin@example.com" },
        { providerId: "google.com", email: "admin@example.com" },
      ],
      customClaims: CLAIMS,
      // Seeded long before this sign-in, its claims set since: established, so rule 4 doesn't apply.
      tokensValidAfterTime: utc(CREATED),
    };
    signIn(pwTok({ email: "admin@example.com", ...CLAIMS }), user(seeded));
    await expect(ensureAdminAccess("t", CREATED + 86_400_000)).resolves.toBe("ready");
    // And with Google, as `npm run local` signs in.
    signIn(tok({ email: "admin@example.com", auth_time: (CREATED + 86_400_000) / 1000, ...CLAIMS }), user(seeded));
    await expect(ensureAdminAccess("t", CREATED + 86_400_000)).resolves.toBe("ready");
    expect(deleteUser).not.toHaveBeenCalled();
  });
});

describe("ensureAdminAccess: authorization + bootstrap", () => {
  it("mints claims (needs_refresh) for a fresh Google sign-in on an allowed domain", async () => {
    signIn(tok(), user()); // no tenant_id/region yet
    await expect(ensureAdminAccess("t", NOW)).resolves.toBe("needs_refresh");
    expect(setCustomUserClaims).toHaveBeenCalledTimes(1);
    expect(setCustomUserClaims).toHaveBeenCalledWith("u1", { tenant_id: "ten_demo", region: "eu", role: "admin" });
  });

  it("mints claims for a code-confirmed password account on the email list", async () => {
    vi.stubEnv("ADMIN_ALLOWED_DOMAINS", "");
    vi.stubEnv("ADMIN_ALLOWED_EMAILS", EMAIL);
    signIn(pwTok(), user({ providerData: passwordData, customClaims: { email_code: true } }));
    await expect(ensureAdminAccess("t", NOW)).resolves.toBe("needs_refresh");
    expect(setCustomUserClaims).toHaveBeenCalledWith("u1", { tenant_id: "ten_demo", region: "eu", role: "admin" });
  });

  it("answers google_only for a password sign-in allowed only through the domain list (D3)", async () => {
    // A Workspace admin who added a password with Forgot password, signing in with it.
    signIn(pwTok(CLAIMS), user({ providerData: [{ providerId: "google.com", email: EMAIL }, ...passwordData], customClaims: CLAIMS }));
    await expect(ensureAdminAccess("t", NOW)).resolves.toBe("google_only");
    expect(setCustomUserClaims).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("refuses with not_set_up, and mints nothing, when no bootstrap tenant is configured", async () => {
    for (const value of ["", "   "]) {
      vi.stubEnv("ADMIN_BOOTSTRAP_TENANT_ID", value);
      signIn(tok(), user());
      await expect(ensureAdminAccess("t", NOW)).resolves.toBe("not_set_up");
    }
    expect(setCustomUserClaims).not.toHaveBeenCalled();
  });

  it("still lets an admin who already has a tenant in when no bootstrap tenant is configured", async () => {
    vi.stubEnv("ADMIN_BOOTSTRAP_TENANT_ID", "");
    signIn(tok({ tenant_id: "ten_demo", region: "us" }), user({ customClaims: CLAIMS }));
    await expect(ensureAdminAccess("t", NOW)).resolves.toBe("ready");
  });

  it("is ready when the verified token already carries tenant_id + region", async () => {
    signIn(tok({ tenant_id: "ten_demo", region: "us" }), user({ customClaims: CLAIMS }));
    await expect(ensureAdminAccess("t", NOW)).resolves.toBe("ready");
    expect(setCustomUserClaims).not.toHaveBeenCalled();
  });

  it("forbids a verified Google identity that is not on any admin list", async () => {
    signIn(tok({ email: "stranger@example.net" }), user({ email: "stranger@example.net", providerData: [{ providerId: "google.com", email: "stranger@example.net" }] }));
    await expect(ensureAdminAccess("t", NOW)).resolves.toBe("forbidden");
    expect(setCustomUserClaims).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("forbids everyone when no admin domain or email is configured", async () => {
    vi.stubEnv("ADMIN_ALLOWED_DOMAINS", "");
    signIn(tok(), user());
    await expect(ensureAdminAccess("t", NOW)).resolves.toBe("forbidden");
  });

  it("fails closed at the self-serve seam, minting nothing", async () => {
    flags.isSelfServeSignupOpen.mockReturnValue(true);
    signIn(tok({ email: "stranger@example.net" }), user({ email: "stranger@example.net", providerData: [{ providerId: "google.com", email: "stranger@example.net" }] }));
    await expect(ensureAdminAccess("t", NOW)).resolves.toBe("forbidden");
    expect(setCustomUserClaims).not.toHaveBeenCalled();
  });
});

describe("revokeAllSessions", () => {
  it("revokes every refresh token the account holds", async () => {
    await revokeAllSessions("u1");
    expect(revokeRefreshTokens).toHaveBeenCalledWith("u1");
  });
});
