import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import type { AdminGate } from "@/lib/connect/admin";
import { isEmailStyleEnabled } from "./flags";

/**
 * Gate for the Email style admin APIs (Save, Reset, Dismiss a suggestion): origin, flag,
 * sign-in and admin, in that order. Members can view the page but change nothing.
 */
export async function emailStyleAdmin(req: Request): Promise<AdminGate> {
  const blocked = sameOriginGuard(req);
  if (blocked) return { ok: false, response: blocked };
  if (!isEmailStyleEnabled()) {
    return { ok: false, response: NextResponse.json({ error: "email_style_disabled" }, { status: 503 }) };
  }
  const ctx = await getAdminContext();
  if (!ctx) return { ok: false, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  if (ctx.role !== "admin") return { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  return { ok: true, ctx };
}
