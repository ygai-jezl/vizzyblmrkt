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
import { adminAuth } from "./adminAuth";
import { isAllowedAdmin } from "./allowlist";
import { emailDomain, judgeSignIn, type TrustVerdict } from "./trust";

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
 *
 * This is the one door (ADR-0014, rule 1): only ensureAdminAccess gives an account its
 * tenant and role claims, and only this file makes session cookies or revokes them. The
 * one-door test (./oneDoor.test.ts) fails if code outside src/lib/auth verifies a token,
 * makes or checks a session cookie, sets claims, revokes or deletes an Auth user.
 */
const SESSION_COOKIE = "__session";
const ACTIVE_TENANT_COOKIE = "active_tenant";
const SESSION_TTL_MS = 5 * 24 * 60 * 60 * 1000; // 5 days

export type AdminAccess =
  | "ready"
  | "needs_refresh"
  | "forbidden"
  | "not_set_up"
  | "email_not_verified"
  | "google_only"
  | "sign_in_again";

/**
 * The door. Verify the ID token (refusing revoked ones), read the account as Auth holds
 * it now, judge the sign-in (./trust.ts), check the admin lists (./allowlist.ts), and
 * BOOTSTRAP the tenant/role claims on first sign-in. Returns:
 *  - "forbidden"          → not a Google or password sign-in, a trojan on an established
 *                           account, an unverified Google email, or not an allowed account
 *  - "email_not_verified" → a password account that hasn't confirmed its emailed code yet
 *  - "google_only"        → allowed only through the domain list, but signed in with a password
 *  - "sign_in_again"      → a first sign-in the door can't trust: the Auth account was deleted
 *                           (it held nothing of ours yet) and the person must sign in again
 *  - "needs_refresh"      → just minted claims; the client must refresh its ID token
 *                           and call again so the new token carries the claims
 *  - "ready"              → the token already has tenant_id+region; create the session
 *  - "not_set_up"         → an allowed account with no tenant yet, and no
 *                           ADMIN_BOOTSTRAP_TENANT_ID to put it in (the deployment
 *                           hasn't named its first workspace)
 *
 * The local emulator runs the same checks: the seeded demo admin is verified, has its claims,
 * and has password and Google sign-in linked for its own address (src/lib/dev/seedAdmin.ts).
 */
export async function ensureAdminAccess(idToken: string, now: number = Date.now()): Promise<AdminAccess> {
  const auth = adminAuth();
  const decoded = await auth.verifyIdToken(idToken, true);
  const account = await auth.getUser(decoded.uid);
  // AUTHENTICATION: which sign-ins the door trusts at all (rules 2 and 4).
  const verdict = judgeSignIn({ token: decoded, account, now });
  if (verdict.kind === "remove") {
    // Remove only an account whose address could get in. Someone on no list who signs in again
    // later fails rule 4 too, but their account can never hold anything of ours: refuse it as
    // before, without deleting it or counting it as a removal (the alert watches removals).
    const could = isAllowedAdmin(decoded.email, decoded.hd as string | undefined, verdict.provider);
    if (could === "google_only") return "google_only";
    if (could !== "allowed") return "forbidden";
    await removeAccount(decoded.uid, account.email, verdict);
    return "sign_in_again";
  }
  if (verdict.kind === "refuse") {
    if (verdict.reason === "trojan" || verdict.reason === "provider_email_changed") {
      logAuthEvent("auth_sign_in_refused", verdict.reason, verdict.provider, account.email);
    }
    return verdict.reason === "email_not_verified" && verdict.provider === "password"
      ? "email_not_verified"
      : "forbidden";
  }
  // AUTHORIZATION: which tenant/role this verified identity gets.
  const listed = isAllowedAdmin(decoded.email, decoded.hd as string | undefined, verdict.provider);
  if (listed === "google_only") return "google_only";
  if (listed === "self_serve") {
    // FUTURE(self-service): the self-serve seam. A verified identity on no admin list, while
    // self-serve sign-up is open, will be routed to creating its OWN tenant here. Unreachable
    // today (isSelfServeSignupOpen is false until self-serve brand creation ships), and it
    // fails closed, so widening anything can never drop a stranger into the bootstrap tenant.
    return "forbidden";
  }
  if (listed !== "allowed") return "forbidden";
  if (!decoded.tenant_id || !decoded.region) {
    // The tenant a first-time admin joins. No default: a deployment names its own.
    const tenantId = process.env.ADMIN_BOOTSTRAP_TENANT_ID?.trim();
    if (!tenantId) return "not_set_up";
    await auth.setCustomUserClaims(decoded.uid, {
      tenant_id: tenantId,
      region: process.env.ADMIN_BOOTSTRAP_REGION ?? "us",
      role: "admin",
    });
    return "needs_refresh";
  }
  return "ready";
}

/**
 * Rule 4: delete an Auth account the door can't trust on its first sign-in. It holds no
 * claims and no data of ours yet, and deleting (not cleaning) it is what stops any code
 * a squatter saved for it from working later.
 */
async function removeAccount(
  uid: string,
  email: string | undefined,
  verdict: Extract<TrustVerdict, { kind: "remove" }>,
): Promise<void> {
  try {
    await adminAuth().deleteUser(uid);
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    // Already gone (a second door call for the same sign-in got there first): removed all the same.
    if (code !== "auth/user-not-found") {
      logAuthEvent("auth_account_remove_failed", verdict.reason, verdict.provider, email, {
        errorCode: typeof code === "string" ? code : "unknown",
      });
      throw err;
    }
  }
  logAuthEvent("auth_account_removed", verdict.reason, verdict.provider, email, {
    accountAgeSeconds: verdict.accountAgeSeconds,
  });
}

/**
 * One structured line for Cloud Logging (a JSON line becomes jsonPayload, so an alert can
 * match `jsonPayload.event`). Carries the address's domain only, never the address.
 */
function logAuthEvent(
  event: string,
  reason: string,
  provider: string,
  email: string | undefined,
  extra: Record<string, unknown> = {},
): void {
  console.warn(
    JSON.stringify({
      severity: "WARNING",
      message: `[auth] ${event}`,
      event,
      reason,
      provider,
      emailDomain: emailDomain(email),
      ...extra,
    }),
  );
}

/**
 * Sign out everywhere: revoke every refresh token the account holds. Every session cookie
 * minted before now then fails verifySessionCookie(checkRevoked), and every device must
 * sign in again. The caller clears this browser's cookies with destroySession.
 */
export async function revokeAllSessions(uid: string): Promise<void> {
  await adminAuth().revokeRefreshTokens(uid);
}

/** Exchange a freshly-minted ID token for a long-lived session cookie. */
export async function createSession(idToken: string): Promise<void> {
  const cookie = await adminAuth().createSessionCookie(idToken, {
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
    const decoded = await adminAuth().verifySessionCookie(session, true);
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
