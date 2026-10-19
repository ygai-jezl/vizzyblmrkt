import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DecodedIdToken } from "firebase-admin/auth";

// ── Stub firebase-admin so ensureAdminAccess runs without real credentials. ──
// Wrapper-arrow style (see crm/enrichWorker.test.ts) so the spies stay
// controllable per-test despite vi.mock hoisting.
const verifyIdToken = vi.fn();
const setCustomUserClaims = vi.fn();
const createSessionCookie = vi.fn();

vi.mock("firebase-admin/app", () => ({
  // Non-empty → adminApp() returns the existing app and skips initializeApp.
  getApps: () => [{}],
  initializeApp: () => ({}),
  applicationDefault: () => ({}),
}));
vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({
    verifyIdToken: (...a: unknown[]) => verifyIdToken(...a),
    setCustomUserClaims: (...a: unknown[]) => setCustomUserClaims(...a),
    createSessionCookie: (...a: unknown[]) => createSessionCookie(...a),
  }),
}));
// session.ts imports these at module top; they're never called by ensureAdminAccess.
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import { ensureAdminAccess, isVerifiedGoogleIdentity } from "./session";

/** A verified Google identity on the test allowlist (example.com). */
function tok(overrides: Record<string, unknown> = {}): DecodedIdToken {
  return {
    uid: "u1",
    email: "founder@example.com",
    email_verified: true,
    firebase: { sign_in_provider: "google.com", identities: {} },
    ...overrides,
  } as unknown as DecodedIdToken;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Force the "real deploy" path: not the emulator (empty string → falsy).
  vi.stubEnv("FIREBASE_AUTH_EMULATOR_HOST", "");
  vi.stubEnv("FIRESTORE_EMULATOR_HOST", "");
  // Nothing is allowed by default; these tests run as a deployment that names its own.
  vi.stubEnv("ADMIN_ALLOWED_DOMAINS", "example.com");
  vi.stubEnv("ADMIN_BOOTSTRAP_TENANT_ID", "ten_demo");
  vi.stubEnv("ADMIN_BOOTSTRAP_REGION", "eu");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isVerifiedGoogleIdentity", () => {
  it("accepts only a verified email from the google.com provider", () => {
    expect(isVerifiedGoogleIdentity(tok())).toBe(true);
    expect(isVerifiedGoogleIdentity(tok({ email_verified: false }))).toBe(false);
    expect(
      isVerifiedGoogleIdentity(
        tok({ firebase: { sign_in_provider: "password", identities: {} } }),
      ),
    ).toBe(false);
  });
});

describe("ensureAdminAccess — authentication gate", () => {
  it("rejects an unverified email even if the domain is allowlisted (core vuln closed)", async () => {
    verifyIdToken.mockResolvedValue(tok({ email_verified: false }));
    await expect(ensureAdminAccess("t")).resolves.toBe("forbidden");
    expect(setCustomUserClaims).not.toHaveBeenCalled();
  });

  it("rejects a non-Google sign-in provider (e.g. email/password) in a real deploy", async () => {
    verifyIdToken.mockResolvedValue(
      tok({ firebase: { sign_in_provider: "password", identities: {} } }),
    );
    await expect(ensureAdminAccess("t")).resolves.toBe("forbidden");
    expect(setCustomUserClaims).not.toHaveBeenCalled();
  });

  it("bypasses the strict provider check under the Auth emulator (smoke path)", async () => {
    vi.stubEnv("FIREBASE_AUTH_EMULATOR_HOST", "127.0.0.1:9099");
    // Emulator smoke test signs in with email/password + unverified email.
    verifyIdToken.mockResolvedValue(
      tok({ email_verified: false, firebase: { sign_in_provider: "password", identities: {} } }),
    );
    // Auth gate skipped → allowlist passes (example.com) → missing claims → needs_refresh.
    await expect(ensureAdminAccess("t")).resolves.toBe("needs_refresh");
    expect(setCustomUserClaims).toHaveBeenCalledTimes(1);
  });
});

describe("ensureAdminAccess — authorization + bootstrap", () => {
  it("mints claims (needs_refresh) for a verified allowlisted identity on first sign-in", async () => {
    verifyIdToken.mockResolvedValue(tok()); // no tenant_id/region yet
    await expect(ensureAdminAccess("t")).resolves.toBe("needs_refresh");
    expect(setCustomUserClaims).toHaveBeenCalledTimes(1);
    expect(setCustomUserClaims).toHaveBeenCalledWith("u1", { tenant_id: "ten_demo", region: "eu", role: "admin" });
  });

  it("refuses with not_set_up, and mints nothing, when no bootstrap tenant is configured", async () => {
    for (const value of ["", "   "]) {
      vi.stubEnv("ADMIN_BOOTSTRAP_TENANT_ID", value);
      verifyIdToken.mockResolvedValue(tok());
      await expect(ensureAdminAccess("t")).resolves.toBe("not_set_up");
    }
    expect(setCustomUserClaims).not.toHaveBeenCalled();
  });

  it("still lets an admin who already has a tenant in when no bootstrap tenant is configured", async () => {
    vi.stubEnv("ADMIN_BOOTSTRAP_TENANT_ID", "");
    verifyIdToken.mockResolvedValue(tok({ tenant_id: "ten_demo", region: "us" }));
    await expect(ensureAdminAccess("t")).resolves.toBe("ready");
  });

  it("is ready when the verified token already carries tenant_id + region", async () => {
    verifyIdToken.mockResolvedValue(tok({ tenant_id: "ten_demo", region: "us" }));
    await expect(ensureAdminAccess("t")).resolves.toBe("ready");
    expect(setCustomUserClaims).not.toHaveBeenCalled();
  });

  it("forbids a verified Google identity that is not on the operator allowlist (future self-service hook)", async () => {
    verifyIdToken.mockResolvedValue(tok({ email: "stranger@gmail.com" }));
    await expect(ensureAdminAccess("t")).resolves.toBe("forbidden");
    expect(setCustomUserClaims).not.toHaveBeenCalled();
  });

  it("forbids everyone when no admin domain or email is configured", async () => {
    vi.stubEnv("ADMIN_ALLOWED_DOMAINS", "");
    verifyIdToken.mockResolvedValue(tok());
    await expect(ensureAdminAccess("t")).resolves.toBe("forbidden");
  });
});
