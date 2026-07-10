import { NextResponse } from "next/server";
import { verifyUnsubscribeToken } from "@/lib/email/unsubscribeToken";
import { applyUnsubscribe } from "@/lib/email/unsubscribeAction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public unsubscribe endpoint. Authorised by the SIGNED token (not a session /
 * same-origin — inbox providers POST here cross-origin), so it must stay
 * publicly reachable. Powers:
 *   - the RFC 8058 one-click List-Unsubscribe-Post header (a machine POST with
 *     body `List-Unsubscribe=One-Click`; the token rides in `?u=`), and
 *   - the hosted preference page's "Unsubscribe" button (a fetch POST).
 * GET redirects to the human page.
 */

/** One-click / confirm unsubscribe. */
export async function POST(req: Request) {
  // Token from `?u=` (where the List-Unsubscribe header carries it) or a JSON body.
  const urlToken = new URL(req.url).searchParams.get("u") ?? "";
  let bodyToken = "";
  if ((req.headers.get("content-type") ?? "").includes("application/json")) {
    const body = (await req.json().catch(() => null)) as { u?: string } | null;
    bodyToken = typeof body?.u === "string" ? body.u : "";
  }
  const token = (urlToken || bodyToken).trim();

  const verified = verifyUnsubscribeToken(token);
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error }, { status: 400 });
  }
  const { ok } = await applyUnsubscribe(verified.claims, "footer");
  if (!ok) return NextResponse.json({ error: "tenant_not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

/** Non-one-click clients that GET the List-Unsubscribe URL → the human page. */
export function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("u") ?? "";
  const dest = new URL("/unsubscribe", req.url);
  if (token) dest.searchParams.set("u", token);
  return NextResponse.redirect(dest);
}
