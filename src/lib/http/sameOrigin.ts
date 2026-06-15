import { NextResponse } from "next/server";

/**
 * CSRF defence-in-depth for state-changing admin requests, on top of the
 * SameSite=Lax session cookie: reject cross-site fetches, and require the
 * `Origin` header (when present) to match the forwarded host.
 *
 * Returns a 403 `NextResponse` to short-circuit on failure, or `null` when the
 * request is same-origin and the handler may proceed.
 */
export function sameOriginGuard(req: Request): NextResponse | null {
  const secFetchSite = req.headers.get("sec-fetch-site");
  if (secFetchSite === "cross-site") {
    return NextResponse.json({ error: "cross_site_forbidden" }, { status: 403 });
  }
  const origin = req.headers.get("origin");
  if (origin) {
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null;
    }
    if (originHost !== host) {
      return NextResponse.json({ error: "bad_origin" }, { status: 403 });
    }
  }
  return null;
}
