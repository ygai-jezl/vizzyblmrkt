import { NextResponse } from "next/server";
import { personViewAdmin } from "@/lib/audience/admin";
import { loadAudiencePeople, PEOPLE_WINDOW } from "@/lib/audience/people";
import { isInvitesEnabled, isInvitesUiEnabled } from "@/lib/invites/flags";
import { invitedProductUsers } from "@/lib/invites/audience";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Audience → Product users (AUDIENCE_PERSON_VIEW): your products' people, each with their stage. */
export async function GET(req: Request) {
  const gate = await personViewAdmin(req, { mutate: false });
  if (!gate.ok) return gate.response;
  const { people, truncated } = await loadAudiencePeople(gate.ctx);
  let rows = people;
  if (isInvitesUiEnabled() && isInvitesEnabled()) {
    const invited = await invitedProductUsers(gate.ctx, people.map((p) => p.id)).catch(() => new Set<string>());
    rows = people.map((p) => ({ ...p, invited: invited.has(p.id) }));
  }
  return NextResponse.json({ people: rows, truncated, window: PEOPLE_WINDOW }, { headers: { "cache-control": "no-store" } });
}
