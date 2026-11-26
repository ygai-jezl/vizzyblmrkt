import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContextWithHome } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { eraseStatus, parseEraseTarget, startFieldCount, startFieldErase } from "@/lib/settings/eraseArchived";
import { isSettingsEraseEnabled } from "@/lib/settings/flags";
import { verifiedPersonOf } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };

/** The switch (off = the route doesn't exist), same origin, then a session: who may erase is checked live after. */
async function gate(req: Request) {
  if (!isSettingsEraseEnabled()) return { ok: false as const, response: NextResponse.json({ error: "not_found" }, { status: 404, headers: noStore }) };
  const blocked = sameOriginGuard(req);
  if (blocked) return { ok: false as const, response: blocked };
  const session = await getAdminContextWithHome();
  if (!session) return { ok: false as const, response: NextResponse.json({ error: "unauthorized" }, { status: 401, headers: noStore }) };
  return { ok: true as const, ctx: session.ctx, person: verifiedPersonOf(session) };
}

/**
 * An archived field's erase as it stands (`?object=&fieldId=`): whether this person may start one,
 * and the count or erase running or done (SETTINGS_ERASE_ENABLED).
 */
export async function GET(req: Request) {
  const g = await gate(req);
  if (!g.ok) return g.response;
  const url = new URL(req.url);
  const target = parseEraseTarget(url.searchParams.get("object"), url.searchParams.get("fieldId"));
  if (!target) return NextResponse.json({ error: "invalid_input" }, { status: 400, headers: noStore });
  const r = await eraseStatus(g.ctx, g.person, target);
  return NextResponse.json(r.body, { status: r.status, headers: noStore });
}

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("count"), object: z.string(), fieldId: z.string() }).strict(),
  z.object({ action: z.literal("erase"), object: z.string(), fieldId: z.string(), name: z.string().max(200) }).strict(),
]);

/**
 * Count what holds an archived field's values, then erase them with its name typed. Only an owner
 * of the organisation with a real admin row for the brand, 30 days after the field was archived.
 */
export async function POST(req: Request) {
  const g = await gate(req);
  if (!g.ok) return g.response;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  const target = parsed.success ? parseEraseTarget(parsed.data.object, parsed.data.fieldId) : null;
  if (!parsed.success || !target) return NextResponse.json({ error: "invalid_input" }, { status: 400, headers: noStore });
  const r = parsed.data.action === "count" ? await startFieldCount(g.ctx, g.person, target) : await startFieldErase(g.ctx, g.person, { ...target, name: parsed.data.name });
  return NextResponse.json(r.body, { status: r.status, headers: noStore });
}
