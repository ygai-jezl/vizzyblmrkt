/** Base class for all tenant-isolation failures. */
export class TenantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** No active tenant could be resolved for the request (host/claim). */
export class TenantNotFoundError extends TenantError {}

/**
 * A caller attempted to read/mutate a document outside its tenant, or a
 * required tenant field was missing. This should be treated as a security
 * event, not an ordinary 404 — log it.
 */
export class TenantIsolationError extends TenantError {}

/** Malformed tenant context (e.g. missing tenantId / tenant_id claim). */
export class TenantValidationError extends TenantError {}
