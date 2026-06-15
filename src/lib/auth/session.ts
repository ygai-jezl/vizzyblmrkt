import {
  getApps,
  initializeApp,
  applicationDefault,
  type App,
} from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { tenantContextFromClaims, type VerifiedClaims } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { Region } from "@/lib/types/tenant";
import type { TenantRole } from "@/lib/types/tenantUser";

/**
 * Server-side admin session. Auth is decoupled from Firestore (no tenant data
 * touched here): the verified ID-token / session-cookie CLAIMS carry tenant_id,
 * region, and role, which become the TenantContext. The session lives in an
 * HttpOnly cookie (never exposed to JS).
 */
const SESSION_COOKIE = "__session";
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
}

/** The authenticated admin's TenantContext, or null if not signed in. */
export async function getAdminContext(): Promise<TenantContext | null> {
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
    };
    return tenantContextFromClaims(claims);
  } catch {
    return null; // expired/invalid/revoked, or missing tenant_id/region claims
  }
}

/** Require a signed-in admin; redirect to /login otherwise. */
export async function requireAdminContext(): Promise<TenantContext> {
  const ctx = await getAdminContext();
  if (!ctx) redirect("/login");
  return ctx;
}
