/**
 * Build the request origin (scheme + host) from request headers, consistently
 * across the App Hosting LB (which sets x-forwarded-*) and local dev. Used to
 * resolve host → tenant. The host is client-controllable, so it is only ever
 * used for ROUTING — never as an authorization grant.
 */
export function originFromHeaders(headers: Headers): string {
  const host = headers.get("x-forwarded-host") ?? headers.get("host") ?? "";
  const proto =
    headers.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.0.0.1")
      ? "http"
      : "https");
  return `${proto}://${host}`;
}
