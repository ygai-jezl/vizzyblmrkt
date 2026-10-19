import { NextResponse } from "next/server";
import {
  ensureAdminAccess,
  createSession,
  destroySession,
} from "@/lib/auth/session";
import { WORKSPACE_NOT_SET_UP_MESSAGE } from "@/lib/auth/accessDenied";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Exchange a Google ID token for a session cookie.
 *  - 403 if the account isn't an allowed admin (wrong Workspace domain)
 *  - 403 { error: "workspace_not_set_up" } if it is allowed but has no tenant and
 *    ADMIN_BOOTSTRAP_TENANT_ID is unset, so there is nowhere to put it
 *  - 200 { needsRefresh: true } on first sign-in: claims were just minted; the
 *    client must force-refresh its ID token and POST again
 *  - 200 { ok: true } + Set-Cookie once the token carries the tenant/role claims
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { idToken?: string } | null;
  if (!body?.idToken) {
    return NextResponse.json({ error: "missing_id_token" }, { status: 400 });
  }
  try {
    const access = await ensureAdminAccess(body.idToken);
    if (access === "forbidden") {
      return NextResponse.json({ error: "access_denied" }, { status: 403 });
    }
    if (access === "not_set_up") {
      return NextResponse.json({ error: "workspace_not_set_up", message: WORKSPACE_NOT_SET_UP_MESSAGE }, { status: 403 });
    }
    if (access === "needs_refresh") {
      return NextResponse.json({ needsRefresh: true });
    }
    await createSession(body.idToken);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "invalid_id_token" }, { status: 401 });
  }
}

/** Sign out — clear the session cookie. */
export async function DELETE() {
  await destroySession();
  return NextResponse.json({ ok: true });
}
