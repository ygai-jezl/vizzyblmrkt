/**
 * The explicit tenant-id query param carried through the widget URL in the
 * shared-platform-host routing model. When the embed/hosted widget is served
 * from the platform's own neutral host (NEXT_PUBLIC_PLATFORM_ORIGIN), the host
 * no longer identifies the tenant — `?t=<tenantId>` does.
 *
 * SECURITY: like the Host header, this is a client-controllable ROUTING hint
 * only. It can never authorize a privileged action — the public surfaces it
 * feeds only read public campaign data and write reCAPTCHA-gated signups, and
 * every data access is still partitioned by the resolved tenant. See
 * resolveTenantForRequest in src/lib/tenant/context.ts.
 */
export const TENANT_QUERY_PARAM = "t";

/** Read the tenant-id hint from a request URL (server side). */
export function tenantParamFromUrl(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get(TENANT_QUERY_PARAM) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Append the tenant-id hint to a (relative or absolute) URL. Pass `tenantId`
 * explicitly on the server; on the client, omit it and the current page's `?t=`
 * is reused (the embed iframe / hosted page already carries it). Returns the
 * path unchanged when no tenant id is available, so the origin fallback applies.
 */
export function appendTenantParam(path: string, tenantId?: string): string {
  let id = tenantId;
  if (!id && typeof window !== "undefined") {
    id = new URLSearchParams(window.location.search).get(TENANT_QUERY_PARAM) ?? undefined;
  }
  if (!id) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}${TENANT_QUERY_PARAM}=${encodeURIComponent(id)}`;
}
