import type { FirestoreLike, TenantContext } from "./types";
import type { TenantRole } from "@/lib/types/tenantUser";
import type { Region } from "@/lib/types/tenant";
import { getTenantByOrigin, getTenantById, getTenantMembership } from "./registry";
import { TenantNotFoundError, TenantValidationError } from "./errors";

/**
 * Establish a TenantContext for a PUBLIC request, preferring an EXPLICIT tenant
 * id (the `?t=` hint carried by widgets served from the shared platform host)
 * and falling back to the request ORIGIN (custom domains + already-deployed
 * snippets with no `t`). Suspended/missing tenants are treated as not-found.
 *
 * The tenant id is a routing hint only — exactly the same trust level as the
 * Host header (see src/lib/http/tenantParam.ts). It selects which tenant's
 * PUBLIC campaign + reCAPTCHA-gated signup path runs; it can never authorize a
 * privileged action, and every data access remains tenant-partitioned.
 */
export async function resolveTenantForRequest(
  input: { tenantId?: string; origin: string },
  db?: FirestoreLike,
): Promise<TenantContext> {
  const id = input.tenantId?.trim();
  if (id) {
    const tenant = db ? await getTenantById(id, db) : await getTenantById(id);
    if (!tenant || tenant.status === "suspended") {
      throw new TenantNotFoundError(`No active tenant for id: ${id}`);
    }
    return { tenantId: tenant.id, region: tenant.region, source: "tenant_param" };
  }
  return resolveTenantFromOrigin(input.origin, db);
}

/**
 * Establish a TenantContext for a PUBLIC request from its origin (scheme +
 * host). Suspended tenants are treated as not-found. The tenant's `region`
 * (read from the control-plane registry) is carried so downstream data access
 * routes to the correct regional database. Used by the public landing-page /
 * signup / leaderboard routes.
 */
export async function resolveTenantFromOrigin(
  origin: string,
  db?: FirestoreLike,
): Promise<TenantContext> {
  const tenant = db
    ? await getTenantByOrigin(origin, db)
    : await getTenantByOrigin(origin);
  if (!tenant || tenant.status === "suspended") {
    throw new TenantNotFoundError(`No active tenant for origin: ${origin}`);
  }
  return { tenantId: tenant.id, region: tenant.region, source: "host" };
}

/**
 * The verified claims extracted from a Firebase ID token by the route handler
 * (which calls getAuth().verifyIdToken). We deliberately accept the already
 * verified claims rather than the raw token, so this stays pure and testable
 * and never trusts an unverified value.
 */
export interface VerifiedClaims {
  uid: string;
  tenant_id?: string;
  /** Residency region, minted onto the token at tenant creation (immutable). */
  region?: Region;
  role?: TenantRole;
  /** Standard Firebase claims, carried for the domain-ownership fast-path. */
  email?: string;
  emailVerified?: boolean;
}

/**
 * Establish a TenantContext for an ADMIN-portal request from verified ID-token
 * claims. The tenant and region come from the token claims (`tenant_id`,
 * `region`) — never from the request body.
 */
export function tenantContextFromClaims(claims: VerifiedClaims): TenantContext {
  if (!claims.tenant_id) {
    throw new TenantValidationError("ID token is missing the tenant_id claim");
  }
  if (!claims.region) {
    throw new TenantValidationError("ID token is missing the region claim");
  }
  return {
    tenantId: claims.tenant_id,
    region: claims.region,
    userId: claims.uid,
    role: claims.role ?? "member",
    ...(claims.email ? { email: claims.email } : {}),
    ...(claims.emailVerified !== undefined
      ? { emailVerified: claims.emailVerified }
      : {}),
    source: "idtoken",
  };
}

/**
 * Given the HOME tenant context (from verified ID-token claims) and a CANDIDATE
 * tenant id named by the `active_tenant` cookie, return the context the request
 * should operate under — the heart of brand switching.
 *
 * The candidate is RE-AUTHORIZED on every call: the user must hold a
 * `tenant_users` membership for it AND the tenant must not be suspended. On any
 * failure (no candidate, not a member, tenant missing/deleted, suspended) we
 * return the home context UNCHANGED. A switch can therefore only ever move the
 * user to a tenant they independently belong to — never an escalation; the
 * worst case is their own home tenant. `region` (for regional DB routing) and
 * `role` are taken AUTHORITATIVELY from the target docs, never from the client.
 */
export async function resolveActiveTenant(
  home: TenantContext,
  candidateTenantId: string | undefined,
  db?: FirestoreLike,
): Promise<TenantContext> {
  if (!candidateTenantId || candidateTenantId === home.tenantId || !home.userId) {
    return home;
  }
  const membership = db
    ? await getTenantMembership(home.userId, candidateTenantId, db)
    : await getTenantMembership(home.userId, candidateTenantId);
  if (!membership) return home; // not a member → ignore the cookie (no escalation)
  const tenant = db
    ? await getTenantById(candidateTenantId, db)
    : await getTenantById(candidateTenantId);
  if (!tenant || tenant.status === "suspended") return home; // deleted/suspended → ignore
  return {
    tenantId: tenant.id,
    region: tenant.region,
    userId: home.userId,
    role: membership.role,
    // Same human → carry their verified email across the brand switch.
    ...(home.email ? { email: home.email } : {}),
    ...(home.emailVerified !== undefined ? { emailVerified: home.emailVerified } : {}),
    source: "idtoken",
  };
}
