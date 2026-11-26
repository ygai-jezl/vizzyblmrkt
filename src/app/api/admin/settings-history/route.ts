import { NextResponse } from "next/server";
import { historyAdmin } from "@/lib/settings/admin";
import { isHistoryKind, listHistory } from "@/lib/settings/sources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };

/**
 * Settings › History (SETTINGS_HISTORY_ENABLED): every change to this brand's fields, journeys,
 * product catalogs and shared connections, newest first, a page at a time (`?kind=` one kind,
 * `?subject=` one setting, journey or product, `&cursor=` the next page). Anyone on the team reads.
 */
export async function GET(req: Request) {
  const gate = await historyAdmin(req, { mutate: false });
  if (!gate.ok) return gate.response;
  const url = new URL(req.url);
  const kind = url.searchParams.get("kind");
  if (kind !== null && !isHistoryKind(kind)) return NextResponse.json({ error: "invalid_input" }, { status: 400, headers: noStore });
  const r = await listHistory(gate.ctx, { kind, subject: url.searchParams.get("subject"), cursor: url.searchParams.get("cursor") });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400, headers: noStore });
  return NextResponse.json(r.page, { headers: noStore });
}
