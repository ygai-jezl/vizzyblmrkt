import { NextResponse } from "next/server";
import { addPersonAdmin } from "@/lib/audience/admin";
import { recordHandConsent } from "@/lib/audience/addPerson";
import { parseAgreed } from "@/lib/audience/newPerson";
import { isPersonId } from "@/lib/audience/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };

/**
 * Record how someone added by hand agreed to marketing email (AUDIENCE_ADD_PERSON_ENABLED),
 * admins only: PATCH `{ how, note? }`. Anyone not added by hand answers 409 consent_elsewhere:
 * their consent comes from their launch or product. Recorded already: 200, nothing written.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ personId: string }> }) {
  const gate = await addPersonAdmin(req);
  if (!gate.ok) return gate.response;
  const { personId } = await params;
  if (!isPersonId(personId)) return NextResponse.json({ error: "not_found" }, { status: 404, headers: noStore });
  const agreed = parseAgreed(await req.json().catch(() => null));
  if (!agreed.ok) return NextResponse.json({ error: agreed.error }, { status: 400, headers: noStore });
  const r = await recordHandConsent(gate.ctx, personId, agreed.value);
  if (r.outcome === "rejected") {
    const status = r.error === "not_found" ? 404 : r.error === "consent_elsewhere" ? 409 : 403;
    return NextResponse.json({ error: r.error === "no_user" ? "forbidden" : r.error }, { status, headers: noStore });
  }
  return NextResponse.json({ consent: r.consent, recorded: r.outcome === "recorded" }, { headers: noStore });
}
