import { NextResponse } from "next/server";
import { verifyUnsubscribeTokenAny } from "@/lib/email/unsubscribeToken";
import { applyLifecycleUnsubscribe, applyUnsubscribe } from "@/lib/email/unsubscribeAction";

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
  // The scope comes ONLY from the hosted page's JSON body: a one-click POST
  // (form-encoded `List-Unsubscribe=One-Click`) never carries it, so for a
  // lifecycle token it stops just that email category.
  const urlToken = new URL(req.url).searchParams.get("u") ?? "";
  let bodyToken = "";
  let scope: "category" | "all" = "category";
  if ((req.headers.get("content-type") ?? "").includes("application/json")) {
    const body = (await req.json().catch(() => null)) as { u?: string; scope?: string } | null;
    bodyToken = typeof body?.u === "string" ? body.u : "";
    if (body?.scope === "all") scope = "all";
  }
  const token = (urlToken || bodyToken).trim();

  const verified = verifyUnsubscribeTokenAny(token);
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error }, { status: 400 });
  }
  const { ok } =
    verified.version === 2
      ? await applyLifecycleUnsubscribe(verified.claims, scope, urlToken ? "list-unsubscribe" : "preferences-page")
      : await applyUnsubscribe(verified.claims, "footer");
  if (!ok) return NextResponse.json({ error: "tenant_not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, scope: verified.version === 2 ? scope : "all" });
}

/** Non-one-click clients that GET the List-Unsubscribe URL → the human page. */
export function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("u") ?? "";
  const dest = new URL("/unsubscribe", req.url);
  if (token) dest.searchParams.set("u", token);
  return NextResponse.redirect(dest);
}
