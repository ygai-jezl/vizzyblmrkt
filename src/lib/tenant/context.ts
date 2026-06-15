import type { FirestoreLike, TenantContext } from "./types";
import type { TenantRole } from "@/lib/types/tenantUser";
import type { Region } from "@/lib/types/tenant";
import { getTenantByOrigin } from "./registry";
import { TenantNotFoundError, TenantValidationError } from "./errors";

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
    source: "idtoken",
  };
}
