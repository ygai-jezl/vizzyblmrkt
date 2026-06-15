import { NextResponse } from "next/server";
import {
  ensureAdminAccess,
  createSession,
  destroySession,
} from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Exchange a Google ID token for a session cookie.
 *  - 403 if the account isn't an allowed admin (wrong Workspace domain)
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
