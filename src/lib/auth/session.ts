import {
  getApps,
  initializeApp,
  applicationDefault,
  type App,
} from "firebase-admin/app";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  tenantContextFromClaims,
  resolveActiveTenant,
  type VerifiedClaims,
} from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { Region } from "@/lib/types/tenant";
import type { TenantRole } from "@/lib/types/tenantUser";
import { isAllowedAdmin } from "./allowlist";

/**
 * Server-side admin session. The verified ID-token / session-cookie CLAIMS
 * carry the HOME tenant_id, region, and role, which become the base
 * TenantContext. The session lives in an HttpOnly cookie (never exposed to JS).
 *
 * Brand switching layers an `active_tenant` cookie on top: getAdminContext()
 * re-authorizes that candidate against `tenant_users` membership and overrides
 * the context. The ONLY Firestore read in this layer happens there, and ONLY
 * when that cookie is present and differs from the home tenant — an unswitched
 * session stays fully claim-based / Firestore-decoupled. The candidate is never
 * trusted: a stale/forged/non-member cookie falls back to the home tenant.
 */
const SESSION_COOKIE = "__session";
const ACTIVE_TENANT_COOKIE = "active_tenant";
const SESSION_TTL_MS = 5 * 24 * 60 * 60 * 1000; // 5 days

function adminApp(): App {
  const existing = getApps()[0];
  if (existing) return existing;
  if (
    process.env.FIRESTORE_EMULATOR_HOST ||
    process.env.FIREBASE_AUTH_EMULATOR_HOST
  ) {
    return initializeApp({
      projectId: process.env.GOOGLE_CLOUD_PROJECT ?? "demo-vizzybl",
    });
  }
  return initializeApp({
    credential: applicationDefault(),
    projectId: process.env.GOOGLE_CLOUD_PROJECT,
  });
}

export type AdminAccess = "ready" | "needs_refresh" | "forbidden";

/** The admin login accepts ONLY genuine Google sign-ins (ADR-0003, Google-only). */
const REQUIRED_SIGN_IN_PROVIDER = "google.com";

/**
 * AUTHENTICATION invariant for every session mint: a real, VERIFIED Google
 * identity — the token was minted by Google sign-in AND Google verified the
 * email. This holds identically for today's @yougrow.ai operators and any
 * future self-service tenant owner (both sign in with Google), and it is what
 * makes the email-domain match in isAllowedAdmin trustworthy: the domain is
 * Google-verified, never self-asserted. Without it, a project that has
 * email/password (or anonymous) sign-in enabled would let an attacker mint a
 * token for an unowned address (e.g. anyone@yougrow.ai) and pass the allowlist.
 *
 * Kept separate from AUTHORIZATION (which tenant/role — isAllowedAdmin + the
 * claims bootstrap below) so the future onboarding path can reuse this exact
 * gate before it provisions a new tenant.
 */
export function isVerifiedGoogleIdentity(decoded: DecodedIdToken): boolean {
  return (
    decoded.email_verified === true &&
    decoded.firebase?.sign_in_provider === REQUIRED_SIGN_IN_PROVIDER
  );
}

/**
 * Verify a Google ID token, gate by Workspace domain, and BOOTSTRAP the
 * tenant/role claims on first sign-in. Returns:
 *  - "forbidden"     → not a verified Google identity, or not an allowed account
 *  - "needs_refresh" → just minted claims; the client must refresh its ID token
 *                      and call again so the new token carries the claims
 *  - "ready"         → the token already has tenant_id+region; create the session
 */
export async function ensureAdminAccess(idToken: string): Promise<AdminAccess> {
  const auth = getAuth(adminApp());
  const decoded = await auth.verifyIdToken(idToken);
  // AUTHENTICATION: only a verified Google identity may ever mint a session.
  // The local Auth emulator (smoke test) signs in with email/password, so the
  // strict provider check is bypassed there — never reachable in a real deploy.
  const isEmulator = !!(
    process.env.FIREBASE_AUTH_EMULATOR_HOST || process.env.FIRESTORE_EMULATOR_HOST
  );
  if (!isEmulator && !isVerifiedGoogleIdentity(decoded)) {
    return "forbidden";
  }
  // AUTHORIZATION: which tenant/role this verified identity gets.
  if (!isAllowedAdmin(decoded.email, decoded.hd as string | undefined)) {
    // FUTURE(self-service): a verified Google identity that is NOT on the
    // internal operator allowlist should be routed to a tenant-creation
    // onboarding flow (provisioning their OWN tenant) rather than forbidden.
    // Until that lands we fail closed, so widening the allowlist can never
    // silently drop a stranger into the bootstrap tenant (ten_vzb) as admin.
    return "forbidden";
  }
  if (!decoded.tenant_id || !decoded.region) {
    await auth.setCustomUserClaims(decoded.uid, {
      tenant_id: process.env.ADMIN_BOOTSTRAP_TENANT_ID ?? "ten_vzb",
      region: process.env.ADMIN_BOOTSTRAP_REGION ?? "us",
      role: "admin",
    });
    return "needs_refresh";
  }
  return "ready";
}

/** Exchange a freshly-minted ID token for a long-lived session cookie. */
export async function createSession(idToken: string): Promise<void> {
  const cookie = await getAuth(adminApp()).createSessionCookie(idToken, {
    expiresIn: SESSION_TTL_MS,
  });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, cookie, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_TTL_MS / 1000,
    path: "/",
  });
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  // Reset brand selection on sign-out so the next session starts at home.
  jar.delete(ACTIVE_TENANT_COOKIE);
}

/**
 * Select the active brand for subsequent requests. Carries the SAME cookie
 * flags as the session cookie. The value is only ever a CANDIDATE —
 * getAdminContext re-authorizes it against `tenant_users` on every request, so
 * setting it can never grant access the user doesn't already have.
 */
export async function setActiveTenantCookie(tenantId: string): Promise<void> {
  const jar = await cookies();
  jar.set(ACTIVE_TENANT_COOKIE, tenantId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_TTL_MS / 1000,
    path: "/",
  });
}

export async function clearActiveTenantCookie(): Promise<void> {
  (await cookies()).delete(ACTIVE_TENANT_COOKIE);
}

/**
 * The HOME admin context straight from the verified session-cookie claims —
 * BEFORE any active-brand override. This is the user's base tenant; switching is
 * authorized relative to it, and the home tenant itself needs no membership row.
 * Most code wants getAdminContext() (the effective, post-override context).
 */
export async function getHomeAdminContext(): Promise<TenantContext | null> {
  const jar = await cookies();
  const session = jar.get(SESSION_COOKIE)?.value;
  if (!session) return null;
  try {
    const decoded = await getAuth(adminApp()).verifySessionCookie(session, true);
    const claims: VerifiedClaims = {
      uid: decoded.uid,
      tenant_id: decoded.tenant_id as string | undefined,
      region: decoded.region as Region | undefined,
      role: decoded.role as TenantRole | undefined,
      email: decoded.email,
      emailVerified: decoded.email_verified,
    };
    return tenantContextFromClaims(claims);
  } catch {
    return null; // expired/invalid/revoked, or missing tenant_id/region claims
  }
}

/**
 * The EFFECTIVE context plus the home tenant id, from a SINGLE session
 * verification. The admin layout needs both: the effective (post-override)
 * context to scope the page, and the home tenant id so the brand switcher always
 * lists the user's home brand (which has no tenant_users membership row and so
 * would otherwise disappear once they switch away from it).
 */
export async function getAdminContextWithHome(): Promise<
  { ctx: TenantContext; homeTenantId: string } | null
> {
  const home = await getHomeAdminContext();
  if (!home) return null;
  const active = (await cookies()).get(ACTIVE_TENANT_COOKIE)?.value;
  // resolveActiveTenant returns `home` cleanly when there's no cookie / it names
  // the home tenant (no read) and on a benign mismatch (revoked membership,
  // suspended, deleted). It only THROWS on a genuine registry error — which, by
  // construction, happens only for a SWITCHED session. Silently returning `home`
  // there would operate under the wrong tenant/region (a wrong-tenant write
  // risk), so fail closed (null → re-auth) instead.
  try {
    const ctx = await resolveActiveTenant(home, active);
    return { ctx, homeTenantId: home.tenantId };
  } catch {
    return null;
  }
}

/**
 * The authenticated admin's EFFECTIVE TenantContext — the home context with the
 * active-brand override applied. Null if not signed in.
 */
export async function getAdminContext(): Promise<TenantContext | null> {
  return (await getAdminContextWithHome())?.ctx ?? null;
}

/** Require a signed-in admin; redirect to /login otherwise. */
export async function requireAdminContext(): Promise<TenantContext> {
  const ctx = await getAdminContext();
  if (!ctx) redirect("/login");
  return ctx;
}
