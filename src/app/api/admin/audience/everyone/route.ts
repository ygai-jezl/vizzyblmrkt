import { NextResponse } from "next/server";
import { isRateLimited } from "@/lib/tenant";
import { addPersonAdmin } from "@/lib/audience/admin";
import { addPerson, newPersonInfo } from "@/lib/audience/addPerson";
import { parseNewPerson } from "@/lib/audience/newPerson";
import { isFieldsEnabled } from "@/lib/audience/peopleFlags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };
/** Generous for a team typing people in, tight enough to stop a script filling the list. */
const ADD_LIMIT = { prefix: "audience_add_person", burstLimit: 30, hourlyLimit: 500 };

/**
 * New person (AUDIENCE_ADD_PERSON_ENABLED), admins only. GET is what the form shows first: the
 * plan's people (it warns, never blocks) and, with `?email=`, the company the address matches.
 * POST adds someone by hand: 201 `{ personId }`, or 200 `{ existing: true, personId }` when their
 * address or phone is already held, writing nothing.
 */
export async function GET(req: Request) {
  const gate = await addPersonAdmin(req);
  if (!gate.ok) return gate.response;
  const email = new URL(req.url).searchParams.get("email")?.slice(0, 320) ?? null;
  return NextResponse.json(await newPersonInfo(gate.ctx, email), { headers: noStore });
}

export async function POST(req: Request) {
  const gate = await addPersonAdmin(req);
  if (!gate.ok) return gate.response;
  if (await isRateLimited(`user:${gate.ctx.tenantId}:${gate.ctx.userId ?? "anon"}`, ADD_LIMIT)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: noStore });
  }
  const parsed = parseNewPerson(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400, headers: noStore });
  const r = await addPerson(gate.ctx, parsed.value, { fields: isFieldsEnabled() });
  if (r.outcome === "existing") return NextResponse.json({ existing: true, personId: r.personId }, { headers: noStore });
  if (r.outcome === "rejected") {
    if (r.error === "no_user") return NextResponse.json({ error: "forbidden" }, { status: 403, headers: noStore });
    return NextResponse.json({ error: r.error, ...(r.fieldId ? { fieldId: r.fieldId } : {}) }, { status: 400, headers: noStore });
  }
  return NextResponse.json({ personId: r.personId, fields: r.fields }, { status: 201, headers: noStore });
}
