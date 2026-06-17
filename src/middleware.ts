import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Collapse accidental leading slashes in the request path.
 *
 * A URL such as `https://host//waitlist/x` has the pathname `//waitlist/x`. The
 * Next.js App Router client crashes on hydration when it calls
 * `history.replaceState` with that path: the browser resolves a leading `//` as
 * a protocol-relative (cross-origin) URL — `https://waitlist/x` — and throws an
 * uncaught SecurityError, surfacing as "Application error: a client-side
 * exception has occurred". The server happily renders the page, so the `//`
 * slips through to the browser's address bar where the client router chokes.
 *
 * We catch it at the edge and 308-redirect to the canonical single-slash path,
 * so the address bar is clean before the client router ever boots. 308 (vs 307)
 * preserves the method and is permanently cacheable for these malformed URLs.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("//")) {
    const url = request.nextUrl.clone();
    url.pathname = pathname.replace(/^\/+/, "/");
    return NextResponse.redirect(url, 308);
  }
  return NextResponse.next();
}

export const config = {
  // Run on every request path (including a stray `//` on api/admin/waitlist/
  // embed) but skip Next's internal asset routes, which never carry a leading
  // double slash.
  matcher: "/((?!_next/static|_next/image|favicon.ico).*)",
};
