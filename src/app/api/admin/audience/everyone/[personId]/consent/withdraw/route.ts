import { NextResponse } from "next/server";
import { addPersonAdmin } from "@/lib/audience/admin";
import { withdrawHandConsent } from "@/lib/audience/addPerson";
import { parseWithdraw } from "@/lib/audience/newPerson";
import { isPersonId } from "@/lib/audience/paths";
import { TenantIsolationError } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };

/**
 * Withdraw the marketing email agreement recorded for someone added by hand
 * (AUDIENCE_ADD_PERSON_ENABLED, with the person ids it needs), admins only: POST `{ note? }`.
 * Gate order as New person: the switch, same origin, a session, the admin role, then the input.
 * Anyone not added by hand answers 409 consent_elsewhere, and someone with nothing recorded 409
 * nothing_to_withdraw, and another brand's person 404. Withdrawn already: 200, nothing written.
 */
export async function POST(req: Request, { params }: { params: Promise<{ personId: string }> }) {
  const gate = await addPersonAdmin(req);
  if (!gate.ok) return gate.response;
  const { personId } = await params;
  if (!isPersonId(personId)) return NextResponse.json({ error: "not_found" }, { status: 404, headers: noStore });
  const input = parseWithdraw(await req.json().catch(() => null));
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400, headers: noStore });
  // Another brand's id is refused by the tenant layer: answered as nobody here, never as theirs.
  const r = await withdrawHandConsent(gate.ctx, personId, input.value).catch((err: unknown) => {
    if (err instanceof TenantIsolationError) return { outcome: "rejected" as const, error: "not_found" as const };
    throw err;
  });
  if (r.outcome === "rejected") {
    const status = r.error === "not_found" ? 404 : r.error === "no_user" ? 403 : 409;
    return NextResponse.json({ error: r.error === "no_user" ? "forbidden" : r.error }, { status, headers: noStore });
  }
  return NextResponse.json({ consent: r.consent, withdrawn: r.outcome === "withdrawn" }, { headers: noStore });
}
