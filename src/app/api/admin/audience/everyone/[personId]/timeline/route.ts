import { NextResponse } from "next/server";
import { timelineAdmin } from "@/lib/audience/admin";
import { isPersonId } from "@/lib/audience/paths";
import { loadPersonTimeline } from "@/lib/audience/personTimelineView";
import { InvalidCursorError } from "@/lib/ontology/timeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };

/**
 * One person's timeline (AUDIENCE_TIMELINE_ENABLED), newest first: `?cursor=` for older entries.
 * Anyone on the team can read it, as they can the person's page.
 */
export async function GET(req: Request, { params }: { params: Promise<{ personId: string }> }) {
  const gate = await timelineAdmin(req);
  if (!gate.ok) return gate.response;
  const { personId } = await params;
  if (!isPersonId(personId)) return NextResponse.json({ error: "not_found" }, { status: 404, headers: noStore });
  const cursor = new URL(req.url).searchParams.get("cursor");
  try {
    const page = await loadPersonTimeline(gate.ctx, personId, { cursor });
    if (!page) return NextResponse.json({ error: "not_found" }, { status: 404, headers: noStore });
    return NextResponse.json(page, { headers: noStore });
  } catch (err) {
    if (err instanceof InvalidCursorError) return NextResponse.json({ error: "invalid_cursor" }, { status: 400, headers: noStore });
    throw err;
  }
}
