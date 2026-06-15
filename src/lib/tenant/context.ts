import type { FirestoreLike, TenantContext } from "./types";
import type { TenantRole } from "@/lib/types/tenantUser";
import { getTenantByOrigin } from "./registry";
import { TenantNotFoundError, TenantValidationError } from "./errors";

/**
 * Establish a TenantContext for a PUBLIC request from its origin (scheme +
 * host). Suspended tenants are treated as not-found. Used by the public
 * landing-page / signup / leaderboard routes.
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
  return { tenantId: tenant.id, source: "host" };
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
  role?: TenantRole;
}

/**
 * Establish a TenantContext for an ADMIN-portal request from verified ID-token
 * claims. The tenant comes from the token's `tenant_id` claim — never from the
 * request body.
 */
export function tenantContextFromClaims(claims: VerifiedClaims): TenantContext {
  if (!claims.tenant_id) {
    throw new TenantValidationError("ID token is missing the tenant_id claim");
  }
  return {
    tenantId: claims.tenant_id,
    userId: claims.uid,
    role: claims.role ?? "member",
    source: "idtoken",
  };
}
