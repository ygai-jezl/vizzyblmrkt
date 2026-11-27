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

/**
 * Firestore refused a query because the composite index it needs is missing, or is still
 * building just after a deploy: FAILED_PRECONDITION (gRPC code 9) with "The query requires an
 * index" (the building case adds "That index is currently building"). A reader with an older,
 * slower way to answer can fall back on this and nothing else; any other error is a real failure.
 */
export function isIndexNotReady(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown; details?: unknown };
  const text = [e.message, e.details].filter((t): t is string => typeof t === "string").join(" ");
  const precondition = e.code === 9 || e.code === "failed-precondition" || e.code === "FAILED_PRECONDITION" || text.includes("FAILED_PRECONDITION");
  return precondition && /requires an index|index is currently building/i.test(text);
}
