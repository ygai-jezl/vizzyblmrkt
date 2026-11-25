import { NextResponse } from "next/server";
import {
  ensureAdminAccess,
  createSession,
  destroySession,
  getHomeAdminContext,
  revokeAllSessions,
} from "@/lib/auth/session";
import { WORKSPACE_NOT_SET_UP_MESSAGE } from "@/lib/auth/accessDenied";
import { sameOriginGuard } from "@/lib/http/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The door (ADR-0014): exchange a Google or password sign-in's ID token for a session cookie.
 *  - 400 { error: "missing_id_token" } with no token
 *  - 401 { error: "invalid_id_token" } if the token is bad, expired or revoked
 *  - 403 { error: "access_denied" } if the account isn't an allowed admin, or can't be trusted
 *  - 403 { error: "workspace_not_set_up" } if it is allowed but has no tenant and
 *    ADMIN_BOOTSTRAP_TENANT_ID is unset, so there is nowhere to put it
 *  - 403 { error: "email_not_verified" } for a password account that hasn't confirmed its code
 *  - 403 { error: "google_only" } if it is allowed only through the domain list, but signed in
 *    with a password
 *  - 409 { error: "sign_in_again" } if the door removed the account (an unexplained first
 *    sign-in); the client must sign out of Firebase and sign in again
 *  - 409 { error: "address_updated" } if the door moved a renamed Google admin to their new
 *    address, which revokes this sign-in; the client must sign out of Firebase, and the admin
 *    signs in with Google again
 *  - 200 { needsRefresh: true } on first sign-in: claims were just minted; the
 *    client must force-refresh its ID token and POST again
 *  - 200 { ok: true } + Set-Cookie once the token carries the tenant/role claims
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { idToken?: unknown } | null;
  if (!body?.idToken || typeof body.idToken !== "string") {
    return NextResponse.json({ error: "missing_id_token" }, { status: 400 });
  }
  try {
    const access = await ensureAdminAccess(body.idToken);
    switch (access) {
      case "forbidden":
        return NextResponse.json({ error: "access_denied" }, { status: 403 });
      case "not_set_up":
        return NextResponse.json({ error: "workspace_not_set_up", message: WORKSPACE_NOT_SET_UP_MESSAGE }, { status: 403 });
      case "email_not_verified":
        return NextResponse.json({ error: "email_not_verified" }, { status: 403 });
      case "google_only":
        return NextResponse.json({ error: "google_only" }, { status: 403 });
      case "sign_in_again":
        return NextResponse.json({ error: "sign_in_again" }, { status: 409 });
      case "address_updated":
        return NextResponse.json({ error: "address_updated" }, { status: 409 });
      case "needs_refresh":
        return NextResponse.json({ needsRefresh: true });
      case "ready":
        await createSession(body.idToken);
        return NextResponse.json({ ok: true });
      default: {
        const unknown: never = access;
        throw new Error(`unknown access ${String(unknown)}`);
      }
    }
  } catch {
    return NextResponse.json({ error: "invalid_id_token" }, { status: 401 });
  }
}

/**
 * Sign out.
 *  - No query: clear this browser's session cookie.
 *  - ?scope=everywhere: needs a valid session (else 401 { error: "unauthorized" }); revokes
 *    every refresh token the account holds, so every device's session stops working, then
 *    clears this browser's cookies. Same-origin requests only.
 *  - Any other scope: 400 { error: "invalid_scope" }, and nothing is signed out.
 */
export async function DELETE(req: Request) {
  const scope = new URL(req.url).searchParams.get("scope");
  if (scope === null) {
    await destroySession();
    return NextResponse.json({ ok: true });
  }
  if (scope !== "everywhere") {
    return NextResponse.json({ error: "invalid_scope" }, { status: 400 });
  }
  const bad = sameOriginGuard(req);
  if (bad) return bad;
  const home = await getHomeAdminContext();
  if (!home?.userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    await revokeAllSessions(home.userId);
  } catch {
    // Keep this browser signed in so the person can try again: nothing was revoked.
    return NextResponse.json({ error: "sign_out_failed" }, { status: 500 });
  }
  await destroySession();
  return NextResponse.json({ ok: true });
}
