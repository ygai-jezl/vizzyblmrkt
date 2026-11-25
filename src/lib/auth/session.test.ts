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
const updateUser = vi.fn();

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
    updateUser: (...a: unknown[]) => updateUser(...a),
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

// The Google account id (Google's permanent `sub`) of the admin's Google account, and another one.
const GID = "100000000000000000001";
const OTHER_GID = "100000000000000000002";
const RENAMED = "founder@example.org";
const linkedGoogle = (email = EMAIL, uid = GID) => ({ providerId: "google.com", email, uid });
/** A Google sign-in token whose sign-in used this Google account id. */
const gTok = (overrides: Record<string, unknown> = {}, googleId = GID) =>
  tok({ firebase: { sign_in_provider: "google.com", identities: { "google.com": [googleId], email: [EMAIL] } }, ...overrides });
/** An established admin whose Google address was renamed, with the id recorded (or not). */
const renamedUser = (claims: Record<string, unknown> = { ...CLAIMS, google_id: GID }, google = linkedGoogle(RENAMED)) =>
  user({ customClaims: claims, providerData: [google] });

function signIn(t: DecodedIdToken, u: UserRecord) {
  verifyIdToken.mockResolvedValue(t);
  getUser.mockResolvedValue(u);
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps implementations: reset them so a rejection set in one test never leaks.
  for (const spy of [verifyIdToken, getUser, setCustomUserClaims, createSessionCookie, deleteUser, revokeRefreshTokens, updateUser]) {
    spy.mockReset();
  }
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

describe("ensureAdminAccess: the Google account id", () => {
  it("records the Google account id at the claims bootstrap", async () => {
    signIn(gTok(), user({ providerData: [linkedGoogle()] }));
    await expect(ensureAdminAccess("t", NOW)).resolves.toBe("needs_refresh");
    expect(setCustomUserClaims).toHaveBeenCalledTimes(1);
    expect(setCustomUserClaims).toHaveBeenCalledWith("u1", { tenant_id: "ten_demo", region: "eu", role: "admin", google_id: GID });
  });

  it("records it at the bootstrap of a code-confirmed password account with Google linked too", async () => {
    vi.stubEnv("ADMIN_ALLOWED_EMAILS", EMAIL);
    signIn(pwTok(), user({ providerData: [...passwordData, linkedGoogle()], customClaims: { email_code: true } }));
    await expect(ensureAdminAccess("t", NOW)).resolves.toBe("needs_refresh");
    expect(setCustomUserClaims).toHaveBeenCalledWith("u1", { tenant_id: "ten_demo", region: "eu", role: "admin", google_id: GID });
  });

  it("merges the id into an established admin's claims on a Google sign-in, keeping every claim", async () => {
    const claims = { ...CLAIMS, email_code: true };
    signIn(gTok(CLAIMS), user({ customClaims: claims, providerData: [...passwordData, linkedGoogle()] }));
    await expect(ensureAdminAccess("t", NOW)).resolves.toBe("ready");
    expect(setCustomUserClaims).toHaveBeenCalledTimes(1);
    expect(setCustomUserClaims).toHaveBeenCalledWith("u1", { ...claims, google_id: GID });
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("never records it on a password sign-in", async () => {
    vi.stubEnv("ADMIN_ALLOWED_EMAILS", EMAIL);
    signIn(pwTok(CLAIMS), user({ customClaims: CLAIMS, providerData: [...passwordData, linkedGoogle()] }));
    await expect(ensureAdminAccess("t", NOW)).resolves.toBe("ready");
    expect(setCustomUserClaims).not.toHaveBeenCalled();
  });

  it("leaves an id already recorded alone", async () => {
    signIn(gTok(CLAIMS), user({ customClaims: { ...CLAIMS, google_id: GID }, providerData: [linkedGoogle()] }));
    await expect(ensureAdminAccess("t", NOW)).resolves.toBe("ready");
    expect(setCustomUserClaims).not.toHaveBeenCalled();
  });

  it("never records it on a mismatch", async () => {
    // The shape of a rename with no id recorded: refused as before, and nothing is recorded.
    signIn(gTok(CLAIMS), renamedUser(CLAIMS));
    await expect(ensureAdminAccess("t", NOW)).resolves.toBe("forbidden");
    expect(setCustomUserClaims).not.toHaveBeenCalled();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("still lets the admin in when recording the id fails, and logs it", async () => {
    setCustomUserClaims.mockRejectedValueOnce(Object.assign(new Error("quota"), { code: "auth/quota-exceeded" }));
    signIn(gTok(CLAIMS), user({ customClaims: CLAIMS, providerData: [linkedGoogle()] }));
    await expect(ensureAdminAccess("t", NOW)).resolves.toBe("ready");
    expect(logged()[0]).toMatchObject({ event: "auth_google_id_record_failed", errorCode: "auth/quota-exceeded", emailDomain: "example.com" });
  });
});

describe("ensureAdminAccess: a renamed Google address", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_ALLOWED_DOMAINS", "example.com,example.org");
  });

  it("moves the same Google account to its new address, logs the domains only, and asks for one more sign-in", async () => {
    signIn(gTok(CLAIMS), renamedUser());
    await expect(ensureAdminAccess("t", NOW)).resolves.toBe("address_updated");
    expect(updateUser).toHaveBeenCalledTimes(1);
    expect(updateUser).toHaveBeenCalledWith("u1", { email: RENAMED, emailVerified: true });
    expect(setCustomUserClaims).not.toHaveBeenCalled();
    expect(createSessionCookie).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
    const lines = logged();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      severity: "WARNING",
      event: "auth_google_address_renamed",
      provider: "google.com",
      emailDomain: "example.com",
      newEmailDomain: "example.org",
    });
    const raw = JSON.stringify(warn.mock.calls);
    expect(raw).not.toContain("founder@");
    expect(raw).not.toContain(GID);
  });

  it("can't let the renamed admin in with a refreshed token, only with a fresh Google sign-in", async () => {
    // Firebase as it behaves: an email change moves tokensValidAfterTime to now, and
    // verifyIdToken(_, true) refuses a token whose sign-in (auth_time) came before it. A refreshed
    // token keeps its sign-in's auth_time, so only a new sign-in gets past the door.
    const signedInAt = NOW / 1000 - 2;
    let account = renamedUser();
    let validAfter = CREATED / 1000;
    let token = gTok({ ...CLAIMS, auth_time: signedInAt });
    getUser.mockImplementation(async () => account);
    verifyIdToken.mockImplementation(async (_t: string, checkRevoked: boolean) => {
      if (checkRevoked && (token.auth_time as number) < validAfter) {
        throw Object.assign(new Error("revoked"), { code: "auth/id-token-revoked" });
      }
      return token;
    });
    updateUser.mockImplementation(async (_uid: string, patch: { email: string }) => {
      account = user({ ...account, email: patch.email, tokensValidAfterTime: utc(NOW) });
      validAfter = NOW / 1000;
    });
    await expect(ensureAdminAccess("t", NOW)).resolves.toBe("address_updated");
    // The browser's refreshed token: the new address, the old sign-in time. Revoked.
    token = gTok({ ...CLAIMS, email: RENAMED, auth_time: signedInAt });
    await expect(ensureAdminAccess("t", NOW + 1000)).rejects.toMatchObject({ code: "auth/id-token-revoked" });
    // A fresh Google sign-in on the new address gets in, with the claims kept and nothing moved again.
    token = gTok({ ...CLAIMS, email: RENAMED, auth_time: NOW / 1000 + 5 });
    await expect(ensureAdminAccess("t", NOW + 5000)).resolves.toBe("ready");
    expect(updateUser).toHaveBeenCalledTimes(1);
    expect(setCustomUserClaims).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("checks the NEW address against the admin lists: not allowed, nothing changes", async () => {
    // The old address is on the email list; the new one is on no list.
    vi.stubEnv("ADMIN_ALLOWED_DOMAINS", "");
    vi.stubEnv("ADMIN_ALLOWED_EMAILS", EMAIL);
    signIn(gTok(CLAIMS), renamedUser());
    await expect(ensureAdminAccess("t", NOW)).resolves.toBe("forbidden");
    expect(updateUser).not.toHaveBeenCalled();
    expect(setCustomUserClaims).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
    expect(logged()).toEqual([]);
  });

  it("lets a new address on the email list in", async () => {
    vi.stubEnv("ADMIN_ALLOWED_DOMAINS", "");
    vi.stubEnv("ADMIN_ALLOWED_EMAILS", RENAMED);
    signIn(gTok(CLAIMS), renamedUser());
    await expect(ensureAdminAccess("t", NOW)).resolves.toBe("address_updated");
    expect(updateUser).toHaveBeenCalledWith("u1", { email: RENAMED, emailVerified: true });
  });

  it("refuses, and changes nothing, when another account already has the new address", async () => {
    updateUser.mockRejectedValueOnce(Object.assign(new Error("taken"), { code: "auth/email-already-exists" }));
    signIn(gTok(CLAIMS), renamedUser());
    await expect(ensureAdminAccess("t", NOW)).resolves.toBe("forbidden");
    expect(setCustomUserClaims).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
    const lines = logged();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: "auth_google_rename_conflict", emailDomain: "example.com", newEmailDomain: "example.org" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("founder@");
  });

  it("logs and throws when the move fails for another reason, so nothing is granted", async () => {
    updateUser.mockRejectedValueOnce(Object.assign(new Error("boom"), { code: "auth/internal-error" }));
    signIn(gTok(CLAIMS), renamedUser());
    await expect(ensureAdminAccess("t", NOW)).rejects.toThrow("boom");
    expect(setCustomUserClaims).not.toHaveBeenCalled();
    expect(logged()[0]).toMatchObject({ event: "auth_google_rename_failed", errorCode: "auth/internal-error", newEmailDomain: "example.org" });
  });

  it("refuses another Google account (a different id) as a trojan", async () => {
    signIn(gTok(CLAIMS, OTHER_GID), renamedUser(undefined, linkedGoogle(RENAMED, OTHER_GID)));
    await expect(ensureAdminAccess("t", NOW)).resolves.toBe("forbidden");
    expect(updateUser).not.toHaveBeenCalled();
    expect(setCustomUserClaims).not.toHaveBeenCalled();
    expect(logged()[0]).toMatchObject({ event: "auth_sign_in_refused", reason: "trojan", provider: "google.com" });
  });

  it("refuses a rename when no id is recorded, as before", async () => {
    signIn(gTok(CLAIMS), renamedUser(CLAIMS));
    await expect(ensureAdminAccess("t", NOW)).resolves.toBe("forbidden");
    expect(updateUser).not.toHaveBeenCalled();
    expect(logged()[0]).toMatchObject({ event: "auth_sign_in_refused", reason: "provider_email_changed" });
  });

  it("still removes a trojan on a first sign-in, whatever the ids", async () => {
    signIn(gTok(), renamedUser({ google_id: GID }));
    await expect(ensureAdminAccess("t", NOW)).resolves.toBe("sign_in_again");
    expect(updateUser).not.toHaveBeenCalled();
    expect(deleteUser).toHaveBeenCalledWith("u1");
  });
});

describe("revokeAllSessions", () => {
  it("revokes every refresh token the account holds", async () => {
    await revokeAllSessions("u1");
    expect(revokeRefreshTokens).toHaveBeenCalledWith("u1");
  });
});
