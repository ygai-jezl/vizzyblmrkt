import { NextResponse } from "next/server";
import { createSession, destroySession } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Create a session cookie from a freshly-minted Firebase ID token. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { idToken?: string } | null;
  if (!body?.idToken) {
    return NextResponse.json({ error: "missing_id_token" }, { status: 400 });
  }
  try {
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
